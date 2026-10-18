/**
 * TOZON CRM — Sales Launch Phase 3.6
 * Automated Round-Robin & Intelligent Lead Distribution Service
 * 
 * Safety & Governance Rules:
 * - Disabled by default (DistributionSettingsService.enabled = false).
 * - Requires explicit activation by DIRECTOR or ADMIN.
 * - Only active vetted sales reps (is_sales_rep = true && is_active = 1).
 * - Excludes managers marked as unavailable/on leave (excludedUserIds).
 * - Enforces max concurrent open leads per manager (maxOpenLeadsPerRep).
 * - Working hours awareness (Asia/Dushanbe): can route to pool if outside working window.
 * - Anti-reassignment safeguard: if lead is already assigned to a manager, automated routing will NEVER overwrite.
 * - Graceful fallback to common pool (responsible_user_id = null) when disabled or no reps available.
 */

import { SalesPlansRepository } from '../sales-plans/salesPlans.repository.js';
import { DistributionSettingsService } from './distributionSettings.service.js';
import { isWithinWorkingHours } from '../../utils/businessTime.js';
import { getDB } from '../../db/connection.js';

/**
 * Lightweight in-process Async Mutex to prevent race conditions during concurrent lead assignment.
 */
class AsyncMutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  async acquire() {
    if (!this._locked) {
      this._locked = true;
      return () => this.release();
    }
    return new Promise(resolve => {
      this._queue.push(() => {
        this._locked = true;
        resolve(() => this.release());
      });
    });
  }

  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._locked = false;
    }
  }

  async runExclusive(fn) {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const distributionMutex = new AsyncMutex();
const inFlightWorkloadReservations = new Map();
let lastAssignedIndex = -1;

export class RoundRobinService {
  /**
   * Check if automated distribution is currently enabled via persistent settings or env.
   */
  static isEnabled() {
    const settings = DistributionSettingsService.getSettings();
    if (typeof settings.enabled === 'boolean') {
      return settings.enabled;
    }
    return process.env.LEADS_ROUND_ROBIN_ENABLED === 'true';
  }

  /**
   * Release reserved in-flight slot for a representative.
   */
  static releaseInFlight(userId) {
    const uid = Number(userId);
    const current = inFlightWorkloadReservations.get(uid) || 0;
    if (current <= 1) {
      inFlightWorkloadReservations.delete(uid);
    } else {
      inFlightWorkloadReservations.set(uid, current - 1);
    }
  }

  /**
   * Get in-flight count for a rep.
   */
  static getInFlightWorkload(userId) {
    return inFlightWorkloadReservations.get(Number(userId)) || 0;
  }

  /**
   * Reset in-flight reservations and cursor (used in tests).
   */
  static resetInFlight() {
    inFlightWorkloadReservations.clear();
    lastAssignedIndex = -1;
  }

  /**
   * Fetches eligible sales representatives who are:
   * 1. Active (`is_active = 1`)
   * 2. Certified sales reps (`is_sales_rep = true`)
   * 3. NOT excluded in distribution settings (not on leave/sick leave)
   * 4. Under their concurrent open leads capacity limit (`maxOpenLeadsPerRep`), accounting for live DB count + in-flight reservations.
   */
  static async getEligibleReps() {
    const settings = DistributionSettingsService.getSettings();
    const maxCapacity = settings.maxOpenLeadsPerRep || 25;
    const excludedIds = new Set((settings.excludedUserIds || []).map(Number));

    const managers = await SalesPlansRepository.getSalesManagers();

    // 1. Strict qualification and exclusion check
    const vettedManagers = managers.filter(m => {
      const isActive = m.is_active === 1 || m.is_active === true || m.is_active === '1';
      const isRep = m.is_sales_rep === true || m.is_sales_rep === 1 || m.is_sales_rep === 'true';
      const isExcluded = excludedIds.has(Number(m.id));
      return isActive && isRep && !isExcluded;
    });

    if (vettedManagers.length === 0) return [];

    // 2. Query active open lead workloads from DB
    const db = getDB();
    const managerIds = vettedManagers.map(m => m.id);

    try {
      const { data: openLeads, error } = await db
        .from('leads')
        .select('id, responsible_user_id')
        .in('responsible_user_id', managerIds)
        .in('status', ['NEW', 'IN_PROGRESS', 'NEGOTIATION'])
        .is('archived_at', null);

      if (error) {
        console.warn('[RoundRobinService] Failed to query open leads count, proceeding with base list:', error.message);
        return vettedManagers.map(m => {
          const inFlight = inFlightWorkloadReservations.get(Number(m.id)) || 0;
          return { ...m, openLeadsCount: inFlight, dbOpenLeadsCount: 0, inFlightCount: inFlight, capacityLimit: maxCapacity };
        });
      }

      const counts = {};
      (openLeads || []).forEach(l => {
        const uid = Number(l.responsible_user_id);
        counts[uid] = (counts[uid] || 0) + 1;
      });

      // Filter by capacity and attach workload stats (including live in-flight reservations)
      return vettedManagers
        .map(m => {
          const dbCount = counts[Number(m.id)] || 0;
          const inFlight = inFlightWorkloadReservations.get(Number(m.id)) || 0;
          const totalWorkload = dbCount + inFlight;
          return {
            ...m,
            openLeadsCount: totalWorkload,
            dbOpenLeadsCount: dbCount,
            inFlightCount: inFlight,
            capacityLimit: maxCapacity
          };
        })
        .filter(m => m.openLeadsCount < maxCapacity);
    } catch {
      return vettedManagers.map(m => {
        const inFlight = inFlightWorkloadReservations.get(Number(m.id)) || 0;
        return { ...m, openLeadsCount: inFlight, dbOpenLeadsCount: 0, inFlightCount: inFlight, capacityLimit: maxCapacity };
      });
    }
  }

  /**
   * Selects next rep using either LEAST_LOADED or circular ROUND_ROBIN algorithm.
   */
  static async selectNextRep() {
    const eligible = await this.getEligibleReps();
    if (eligible.length === 0) return null;

    const settings = DistributionSettingsService.getSettings();
    const algorithm = settings.algorithm || 'LEAST_LOADED';

    if (algorithm === 'ROUND_ROBIN') {
      // Pure round-robin cycling
      eligible.sort((a, b) => Number(a.id) - Number(b.id));
      lastAssignedIndex = (lastAssignedIndex + 1) % eligible.length;
      return eligible[lastAssignedIndex];
    }

    // Default: LEAST_LOADED with round-robin tie break
    eligible.sort((a, b) => {
      if (a.openLeadsCount !== b.openLeadsCount) {
        return a.openLeadsCount - b.openLeadsCount;
      }
      return Number(a.id) - Number(b.id);
    });

    const minWorkload = eligible[0].openLeadsCount;
    const tiedCandidates = eligible.filter(e => e.openLeadsCount === minWorkload);

    lastAssignedIndex = (lastAssignedIndex + 1) % tiedCandidates.length;
    return tiedCandidates[lastAssignedIndex];
  }

  /**
   * Evaluates distribution for an incoming lead or lead update.
   * Safety guard: if lead already has a responsible manager, automated distribution NEVER overwrites.
   * Concurrency guard: wrapped in AsyncMutex with atomic slot reservation to eliminate race condition duplicates.
   */
  static async resolveAssignment(explicitManagerId = null, currentResponsibleId = null) {
    return await distributionMutex.runExclusive(async () => {
      // 1. Explicit manual assignment always takes precedence
      if (explicitManagerId !== null && explicitManagerId !== undefined) {
        return {
          responsible_user_id: Number(explicitManagerId),
          assigned_at: new Date().toISOString(),
          assignment_type: 'MANUAL',
          reason: 'Ручное назначение руководителем'
        };
      }

      // 2. Safeguard against overwriting existing assignment
      if (currentResponsibleId !== null && currentResponsibleId !== undefined && Number(currentResponsibleId) > 0) {
        return {
          responsible_user_id: Number(currentResponsibleId),
          assigned_at: null,
          assignment_type: 'EXISTING',
          reason: 'Лид уже закреплен за ответственным менеджером; автоматическая перезапись заблокирована'
        };
      }

      // 3. Automated distribution enabled check
      if (!this.isEnabled()) {
        return {
          responsible_user_id: null,
          assigned_at: null,
          assignment_type: 'POOL',
          reason: 'Автоматическое распределение выключено руководителем; заявка направлена в общий пул'
        };
      }

      // 4. Working hours check (if enabled in settings)
      const settings = DistributionSettingsService.getSettings();
      if (settings.workingHoursOnly && !isWithinWorkingHours()) {
        return {
          responsible_user_id: null,
          assigned_at: null,
          assignment_type: 'POOL',
          reason: 'Вне рабочего времени компании (08:00–20:00 Asia/Dushanbe); заявка направлена в общий пул'
        };
      }

      // 5. Select eligible representative with capacity check
      const nextRep = await this.selectNextRep();
      if (!nextRep) {
        return {
          responsible_user_id: null,
          assigned_at: null,
          assignment_type: 'POOL',
          reason: 'Нет доступных свободных менеджеров (все превысили лимит нагрузки 25 лидов или исключены); заявка направлена в пул'
        };
      }

      // Atomically reserve slot for rep to prevent parallel requests from oversubscribing capacity
      const repId = Number(nextRep.id);
      inFlightWorkloadReservations.set(repId, (inFlightWorkloadReservations.get(repId) || 0) + 1);

      // Auto-release after 15 seconds in case caller fails before DB write
      const timer = setTimeout(() => {
        RoundRobinService.releaseInFlight(repId);
      }, 15000);

      const releaseSlot = () => {
        clearTimeout(timer);
        RoundRobinService.releaseInFlight(repId);
      };

      return {
        responsible_user_id: repId,
        assigned_at: new Date().toISOString(),
        assignment_type: 'ROUND_ROBIN',
        reason: `Автоматическое распределение (${settings.algorithm || 'LEAST_LOADED'}) менеджеру ${nextRep.name}`,
        rep: nextRep,
        releaseSlot
      };
    });
  }
}

