/**
 * TOZON CRM — Transactional Project-Scoped Lead Distribution Service (GAP-01)
 *
 * Source of truth for multi-process concurrency, persistent cursor, project access,
 * working calendar, and capacity checks is PostgreSQL (`fn_select_and_assign_lead_atomic`).
 */

import { SalesPlansRepository } from '../sales-plans/salesPlans.repository.js';
import { DistributionSettingsService } from './distributionSettings.service.js';
import { isWithinWorkingHours } from '../../utils/businessTime.js';
import { getDB, getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';

const getSafeDB = () => {
  try {
    return getServiceDB();
  } catch {
    return getDB();
  }
};

export class RoundRobinService {
  static async isEnabled() {
    const settings = await DistributionSettingsService.getSettings();
    if (settings.state === 'SETTINGS_UNAVAILABLE' || settings.isAvailable === false) {
      return false;
    }
    if (typeof settings.enabled === 'boolean') {
      return settings.enabled;
    }
    return process.env.LEADS_ROUND_ROBIN_ENABLED === 'true';
  }

  // Kept as no-ops for backward compatibility with legacy callers/tests
  static releaseInFlight() {}
  static getInFlightWorkload() { return 0; }
  static resetInFlight() {}

  /**
   * Fetches eligible sales representatives for an optional projectId.
   * Throws explicitly on DB error — NEVER guesses workload as 0.
   */
  static async getEligibleReps({ projectId = null } = {}) {
    const settings = await DistributionSettingsService.getSettings();
    if (settings.state === 'SETTINGS_UNAVAILABLE' || settings.isAvailable === false) {
      throw new AppError('Настройки распределения недоступны', 503);
    }

    const maxCapacity = settings.maxOpenLeadsPerRep || 25;
    const excludedIds = new Set((settings.excludedUserIds || []).map(Number));
    const managers = await SalesPlansRepository.getSalesManagers();

    const vettedManagers = managers.filter((m) => {
      const isActive = m.is_active === 1 || m.is_active === true || m.is_active === '1';
      const isRep = m.is_sales_rep === true || m.is_sales_rep === 1 || m.is_sales_rep === 'true';
      const isExcluded = excludedIds.has(Number(m.id));
      return isActive && isRep && !isExcluded;
    });

    if (vettedManagers.length === 0) return [];

    const db = getSafeDB();
    const managerIds = vettedManagers.map((m) => Number(m.id));

    // Filter by project access (user_project_access or all_projects_access)
    let projectScopedManagers = vettedManagers;
    if (projectId !== null && projectId !== undefined) {
      const { data: accessRows, error: accessErr } = await db
        .from('user_project_access')
        .select('user_id')
        .eq('project_id', Number(projectId))
        .eq('can_view', true)
        .in('user_id', managerIds);

      if (accessErr) {
        throw new AppError(`Ошибка проверки проектного доступа менеджеров: ${accessErr.message}`, 503);
      }

      const allowedByProject = new Set((accessRows || []).map((r) => Number(r.user_id)));
      projectScopedManagers = vettedManagers.filter(
        (m) => Boolean(m.all_projects_access) || allowedByProject.has(Number(m.id))
      );
    } else {
      projectScopedManagers = vettedManagers.filter((m) => Boolean(m.all_projects_access));
    }

    if (projectScopedManagers.length === 0) return [];

    const scopedIds = projectScopedManagers.map((m) => Number(m.id));
    const { data: openLeads, error: leadsErr } = await db
      .from('leads')
      .select('id, responsible_user_id')
      .in('responsible_user_id', scopedIds)
      .in('status', ['NEW', 'IN_PROGRESS', 'NEGOTIATION'])
      .is('archived_at', null);

    if (leadsErr) {
      throw new AppError(`Ошибка расчёта текущей нагрузки менеджеров: ${leadsErr.message}`, 503);
    }

    const counts = {};
    (openLeads || []).forEach((l) => {
      const uid = Number(l.responsible_user_id);
      counts[uid] = (counts[uid] || 0) + 1;
    });

    return projectScopedManagers
      .map((m) => {
        const dbCount = counts[Number(m.id)] || 0;
        return {
          ...m,
          openLeadsCount: dbCount,
          dbOpenLeadsCount: dbCount,
          inFlightCount: 0,
          capacityLimit: maxCapacity
        };
      })
      .filter((m) => m.openLeadsCount < maxCapacity);
  }

  /**
   * Executes transactional candidate selection, capacity check, persistent cursor update,
   * lead assignment, history record, and outbox enqueue inside PostgreSQL.
   */
  static async assignLeadAtomic(
    leadId,
    { actorUserId = null, expectedVersion = null, assignmentSource = 'AUTO', now = null } = {}
  ) {
    const db = getSafeDB();
    const { data, error } = await db.rpc('fn_select_and_assign_lead_atomic', {
      p_lead_id: Number(leadId),
      p_actor_user_id: actorUserId ? Number(actorUserId) : null,
      p_expected_version: expectedVersion !== null && expectedVersion !== undefined ? Number(expectedVersion) : null,
      p_assignment_source: assignmentSource,
      p_now: (now instanceof Date ? now.toISOString() : now) || new Date().toISOString()
    });

    if (error || !data) {
      throw new AppError(`Ошибка транзакционного распределения лида: ${error?.message || 'EMPTY_RPC_RESPONSE'}`, 503);
    }
    return data;
  }

  /**
   * Legacy-compatible pre-create resolution helper.
   * Note: for multi-process atomicity, callers should persist the lead and call `assignLeadAtomic(lead.id)`.
   */
  static async resolveAssignment(explicitManagerId = null, currentResponsibleId = null, { projectId = null } = {}) {
    if (explicitManagerId !== null && explicitManagerId !== undefined) {
      return {
        responsible_user_id: Number(explicitManagerId),
        assigned_at: new Date().toISOString(),
        assignment_type: 'MANUAL',
        reason: 'Ручное назначение руководителем'
      };
    }

    if (currentResponsibleId !== null && currentResponsibleId !== undefined && Number(currentResponsibleId) > 0) {
      return {
        responsible_user_id: Number(currentResponsibleId),
        assigned_at: null,
        assignment_type: 'EXISTING',
        reason: 'Лид уже закреплен за ответственным менеджером; автоматическая перезапись заблокирована'
      };
    }

    const settings = await DistributionSettingsService.getSettings({ forceFresh: true });
    if (settings.state === 'SETTINGS_UNAVAILABLE' || settings.isAvailable === false) {
      return {
        responsible_user_id: null,
        assigned_at: null,
        assignment_type: 'POOL',
        pool_reason: 'SETTINGS_UNAVAILABLE',
        reason: 'Настройки распределения временно недоступны (SETTINGS_UNAVAILABLE); заявка направлена в общий пул'
      };
    }

    if (!settings.enabled) {
      return {
        responsible_user_id: null,
        assigned_at: null,
        assignment_type: 'POOL',
        pool_reason: 'DISTRIBUTION_DISABLED',
        reason: 'Автоматическое распределение выключено руководителем; заявка направлена в общий пул'
      };
    }

    if (settings.workingHoursOnly && !isWithinWorkingHours()) {
      return {
        responsible_user_id: null,
        assigned_at: null,
        assignment_type: 'POOL',
        pool_reason: 'OUTSIDE_WORKING_HOURS',
        reason: 'Вне рабочего времени компании; заявка направлена в общий пул'
      };
    }

    let eligible = [];
    try {
      eligible = await this.getEligibleReps({ projectId });
    } catch (err) {
      return {
        responsible_user_id: null,
        assigned_at: null,
        assignment_type: 'POOL',
        pool_reason: 'WORKLOAD_QUERY_FAILED',
        reason: err.message || 'Ошибка расчёта нагрузки; заявка направлена в общий пул'
      };
    }

    if (eligible.length === 0) {
      return {
        responsible_user_id: null,
        assigned_at: null,
        assignment_type: 'POOL',
        pool_reason: 'NO_ELIGIBLE_REPS',
        reason: 'Нет доступных свободных менеджеров; заявка направлена в пул'
      };
    }

    eligible.sort((a, b) => {
      if ((settings.algorithm || 'LEAST_LOADED') !== 'ROUND_ROBIN' && a.openLeadsCount !== b.openLeadsCount) {
        return a.openLeadsCount - b.openLeadsCount;
      }
      return Number(a.id) - Number(b.id);
    });

    const nextRep = eligible[0];
    return {
      responsible_user_id: Number(nextRep.id),
      assigned_at: new Date().toISOString(),
      assignment_type: 'ROUND_ROBIN',
      reason: `Автоматическое распределение (${settings.algorithm || 'LEAST_LOADED'}) менеджеру ${nextRep.name}`,
      rep: nextRep
    };
  }
}
