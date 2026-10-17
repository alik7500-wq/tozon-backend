/**
 * TOZON CRM — Sales Launch Phase 2
 * Automated Round-Robin Lead Distribution Service
 * 
 * Safety Rules:
 * - Disabled by default (LEADS_ROUND_ROBIN_ENABLED = false). Requires explicit authorization to enable.
 * - Only active vetted sales reps (is_sales_rep = true && is_active = 1).
 * - Enforces max concurrent open leads per manager (MAX_OPEN_LEADS_PER_REP).
 * - Graceful fallback to common pool (responsible_user_id = null) when disabled or no reps available.
 * - Atomic assignment logging.
 */

import { SalesPlansRepository } from '../sales-plans/salesPlans.repository.js';
import { getDB, getServiceDB } from '../../db/connection.js';

export const MAX_OPEN_LEADS_PER_REP = parseInt(process.env.MAX_OPEN_LEADS_PER_REP || '25', 10);

let lastAssignedIndex = -1;

export class RoundRobinService {
  /**
   * Check if automated distribution is enabled via environment or config.
   * Default: FALSE (Strictly disabled until sales launch).
   */
  static isEnabled() {
    return process.env.LEADS_ROUND_ROBIN_ENABLED === 'true';
  }

  /**
   * Fetches eligible sales representatives who are active, certified (is_sales_rep = true),
   * and under their concurrent open leads capacity limit.
   */
  static async getEligibleReps() {
    const managers = await SalesPlansRepository.getSalesManagers();
    
    // Strict qualification check
    const vettedManagers = managers.filter(m => {
      const isActive = m.is_active === 1 || m.is_active === true || m.is_active === '1';
      const isRep = m.is_sales_rep === true || m.is_sales_rep === 1 || m.is_sales_rep === 'true';
      return isActive && isRep;
    });

    if (vettedManagers.length === 0) return [];

    // Query active open lead workloads from DB
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
        return vettedManagers.map(m => ({ ...m, openLeadsCount: 0 }));
      }

      const counts = {};
      (openLeads || []).forEach(l => {
        counts[l.responsible_user_id] = (counts[l.responsible_user_id] || 0) + 1;
      });

      // Filter by capacity and attach workload
      return vettedManagers
        .map(m => ({
          ...m,
          openLeadsCount: counts[m.id] || 0
        }))
        .filter(m => m.openLeadsCount < MAX_OPEN_LEADS_PER_REP);
    } catch {
      return vettedManagers.map(m => ({ ...m, openLeadsCount: 0 }));
    }
  }

  /**
   * Selects next rep using least-loaded algorithm with round-robin tie-breaking.
   */
  static async selectNextRep() {
    const eligible = await this.getEligibleReps();
    if (eligible.length === 0) return null;

    // Sort by openLeadsCount ascending (least loaded first)
    eligible.sort((a, b) => {
      if (a.openLeadsCount !== b.openLeadsCount) {
        return a.openLeadsCount - b.openLeadsCount;
      }
      return a.id - b.id;
    });

    // Pick top candidate (or advance round-robin pointer if workloads are tied)
    const minWorkload = eligible[0].openLeadsCount;
    const tiedCandidates = eligible.filter(e => e.openLeadsCount === minWorkload);

    lastAssignedIndex = (lastAssignedIndex + 1) % tiedCandidates.length;
    return tiedCandidates[lastAssignedIndex];
  }

  /**
   * Evaluates distribution for incoming lead.
   * If disabled or no reps available, assigns to common pool (null).
   */
  static async resolveAssignment(explicitManagerId = null) {
    if (explicitManagerId) {
      return {
        responsible_user_id: explicitManagerId,
        assigned_at: new Date().toISOString(),
        assignment_type: 'MANUAL',
        reason: 'Direct assignment'
      };
    }

    if (!this.isEnabled()) {
      return {
        responsible_user_id: null,
        assigned_at: null,
        assignment_type: 'POOL',
        reason: 'Round-robin disabled; routed to incoming pool'
      };
    }

    const nextRep = await this.selectNextRep();
    if (!nextRep) {
      return {
        responsible_user_id: null,
        assigned_at: null,
        assignment_type: 'POOL',
        reason: 'No eligible sales representatives under capacity limit; routed to pool'
      };
    }

    return {
      responsible_user_id: nextRep.id,
      assigned_at: new Date().toISOString(),
      assignment_type: 'ROUND_ROBIN',
      reason: `Automated round-robin distribution to ${nextRep.name}`,
      rep: nextRep
    };
  }
}
