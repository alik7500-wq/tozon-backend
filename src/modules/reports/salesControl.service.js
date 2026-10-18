import { getDB, getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { getBusinessDate, calculateWorkingMinutes } from '../../utils/businessTime.js';
import { SalesPlansRepository } from '../sales-plans/salesPlans.repository.js';
import { DistributionSettingsService } from '../leads/distributionSettings.service.js';
import { calculateSalesWorkingMinutes, SLA_FIRST_CONTACT_MINUTES } from '../leads/leadSla.service.js';

const getSecureDB = () => {
  try {
    if (typeof getServiceDB === 'function') {
      const sdb = getServiceDB();
      if (sdb) return sdb;
    }
  } catch {}
  return getDB();
};

export class SalesControlService {
  /**
   * Evaluates sales supervisor control metrics and drill-down datasets
   */
  static async getControlDashboardData(user) {
    if (!user) {
      throw new AppError('Пользователь не авторизован', 401);
    }

    if (['FINANCE_MANAGER', 'WAREHOUSE_MANAGER'].includes(user.role)) {
      throw new AppError('Доступ к оперативному контролю продаж запрещен для вашей роли', 403);
    }

    const isSupervisor = ['ADMIN', 'DIRECTOR'].includes(user.role);
    const userId = Number(user.id);
    const today = getBusinessDate();
    const now = new Date();

    const db = getSecureDB();

    // 1. Fetch leads
    let leadsQuery = db
      .from('leads')
      .select(`
        id,
        full_name,
        phone,
        source,
        status,
        responsible_user_id,
        created_at,
        updated_at,
        assigned_at,
        first_contact_at,
        first_contact_outcome,
        users!responsible_user_id ( id, name, role )
      `)
      .is('archived_at', null);

    if (!isSupervisor) {
      // Sales managers see only their own leads
      leadsQuery = leadsQuery.eq('responsible_user_id', userId);
    }

    const { data: rawLeads, error: leadsErr } = await leadsQuery;
    if (leadsErr) {
      console.error('[SalesControlService] Error fetching leads:', leadsErr.message);
      throw new AppError('Ошибка получения данных по лидам для контроля продаж', 500);
    }
    const leads = rawLeads || [];

    // 2. Fetch tasks
    let tasksQuery = db
      .from('tasks')
      .select(`
        id,
        lead_id,
        deal_id,
        assigned_user_id,
        created_by,
        type,
        title,
        description,
        client_name,
        phone,
        due_date,
        priority,
        status,
        created_at,
        users!assigned_user_id ( id, name )
      `)
      .eq('status', 'OPEN');

    if (!isSupervisor) {
      tasksQuery = tasksQuery.eq('assigned_user_id', userId);
    }

    const { data: rawTasks, error: tasksErr } = await tasksQuery;
    if (tasksErr) {
      console.error('[SalesControlService] Error fetching tasks:', tasksErr.message);
      throw new AppError('Ошибка получения данных по задачам для контроля продаж', 500);
    }
    const openTasks = rawTasks || [];

    // 3. Fetch reservations (deals with status = RESERVED)
    let dealsQuery = db
      .from('deals')
      .select(`
        id,
        contract_number,
        status,
        responsible_user_id,
        reservation_expires_at,
        deal_date,
        final_price_minor,
        leads ( id, full_name, phone ),
        units ( id, unit_number, unit_kind, rooms, area_m2_x100, floors ( sections ( buildings ( name, projects ( name ) ) ) ) ),
        users!responsible_user_id ( id, name )
      `)
      .eq('status', 'RESERVED');

    if (!isSupervisor) {
      dealsQuery = dealsQuery.eq('responsible_user_id', userId);
    }

    const { data: rawDeals, error: dealsErr } = await dealsQuery;
    if (dealsErr) {
      console.error('[SalesControlService] Error fetching reserved deals:', dealsErr.message);
      throw new AppError('Ошибка получения данных по бронированиям для контроля продаж', 500);
    }
    const reservedDeals = rawDeals || [];

    // 4. Metric A: Unassigned Leads (only applicable for supervisors)
    const unassignedItems = isSupervisor
      ? leads.filter(l => !l.responsible_user_id && ['NEW', 'IN_PROGRESS'].includes(l.status)).map(l => {
          const workingMins = calculateSalesWorkingMinutes(l.created_at, now);
          return {
            id: l.id,
            fullName: l.full_name || 'Не указано',
            phone: l.phone || '',
            source: l.source || 'Прямой контакт',
            createdAt: l.created_at,
            workingMinutesInPool: workingMins,
            isOverduePool: workingMins > SLA_FIRST_CONTACT_MINUTES
          };
        })
      : [];

    // 5. Metric B: Leads without First Contact (assigned leads in NEW without first contact)
    const noContactItems = leads.filter(l => {
      if (!l.responsible_user_id) return false;
      if (l.status !== 'NEW') return false;
      if (l.first_contact_at) return false;
      const start = l.assigned_at || l.created_at;
      const workingMins = calculateSalesWorkingMinutes(start, now);
      return workingMins >= 10; // Warning or overdue
    }).map(l => {
      const start = l.assigned_at || l.created_at;
      const workingMins = calculateSalesWorkingMinutes(start, now);
      return {
        id: l.id,
        fullName: l.full_name || 'Не указано',
        phone: l.phone || '',
        managerId: l.responsible_user_id,
        managerName: l.users?.name || 'Менеджер',
        assignedAt: l.assigned_at || l.created_at,
        workingMinutesElapsed: workingMins,
        isOverdue: workingMins > SLA_FIRST_CONTACT_MINUTES,
        overdueMinutes: Math.max(0, workingMins - SLA_FIRST_CONTACT_MINUTES)
      };
    });

    // 6. Metric C: Overdue Tasks (due_date < today)
    const overdueTaskItems = openTasks.filter(t => t.due_date && t.due_date < today).map(t => {
      const diffMs = now.getTime() - new Date(t.due_date).getTime();
      const daysOverdue = Math.max(1, Math.floor(diffMs / 86400000));
      return {
        id: t.id,
        leadId: t.lead_id,
        dealId: t.deal_id,
        title: t.title,
        type: t.type,
        clientName: t.client_name || 'Клиент',
        phone: t.phone || '',
        managerId: t.assigned_user_id,
        managerName: t.users?.name || 'Менеджер',
        dueDate: t.due_date,
        daysOverdue,
        priority: t.priority
      };
    });

    // 7. Metric D: Stale Leads (>48 working hours without follow-up and NO open tasks scheduled)
    const leadTasksMap = new Set();
    openTasks.forEach(t => {
      if (t.lead_id) leadTasksMap.add(Number(t.lead_id));
    });

    const staleLeadItems = leads.filter(l => {
      if (!l.responsible_user_id) return false;
      if (!['IN_PROGRESS', 'NEGOTIATION'].includes(l.status)) return false;
      // If lead has an open task, it is active and scheduled
      if (leadTasksMap.has(Number(l.id))) return false;

      const lastActivity = new Date(l.updated_at || l.created_at);
      const hoursElapsed = Math.floor((now.getTime() - lastActivity.getTime()) / 3600000);
      return hoursElapsed >= 48;
    }).map(l => {
      const lastActivity = new Date(l.updated_at || l.created_at);
      const hoursElapsed = Math.floor((now.getTime() - lastActivity.getTime()) / 3600000);
      return {
        id: l.id,
        fullName: l.full_name || 'Не указано',
        phone: l.phone || '',
        status: l.status,
        managerId: l.responsible_user_id,
        managerName: l.users?.name || 'Менеджер',
        lastActivityAt: l.updated_at || l.created_at,
        hoursInactive: hoursElapsed
      };
    });

    // 8. Metric E: Expiring Reservations (expiring within 48 hours or overdue)
    const expiringReservations = reservedDeals.map(d => {
      const expiryDateStr = d.reservation_expires_at || null;
      let hoursUntilExpiry = null;
      let isExpired = false;

      if (expiryDateStr) {
        const expiryDate = new Date(expiryDateStr);
        hoursUntilExpiry = Math.round((expiryDate.getTime() - now.getTime()) / 3600000);
        isExpired = hoursUntilExpiry < 0;
      }

      return {
        id: d.id,
        contractNumber: d.contract_number ? `№${d.contract_number}` : `Бронь #${d.id}`,
        leadId: d.leads?.id,
        clientName: d.leads?.full_name || 'Клиент',
        phone: d.leads?.phone || '',
        unitNumber: d.units?.unit_number || '—',
        projectName: d.units?.floors?.sections?.buildings?.projects?.name || d.units?.floors?.sections?.buildings?.name || 'Объект',
        managerId: d.responsible_user_id,
        managerName: d.users?.name || 'Менеджер',
        reservationExpiresAt: expiryDateStr,
        hoursUntilExpiry,
        isExpired,
        isUrgent: hoursUntilExpiry !== null && hoursUntilExpiry <= 48
      };
    }).filter(d => d.isUrgent || d.isExpired);

    // 9. Metric F: Manager Workload & Capacity Analysis
    let managerWorkloads = [];
    if (isSupervisor) {
      const distributionSettings = await DistributionSettingsService.getSettings();
      const maxLimit = distributionSettings.maxOpenLeadsPerRep || 25;
      const excludedSet = new Set((distributionSettings.excludedUserIds || []).map(Number));

      const allManagers = await SalesPlansRepository.getSalesManagers();
      const activeSalesReps = allManagers.filter(m => {
        const isActive = m.is_active === 1 || m.is_active === true || m.is_active === '1';
        const isRep = m.is_sales_rep === true || m.is_sales_rep === 1 || m.is_sales_rep === 'true';
        return isActive && isRep;
      });

      // Calculate counts per manager
      const managerLeadsCount = {};
      leads.forEach(l => {
        if (l.responsible_user_id && ['NEW', 'IN_PROGRESS', 'NEGOTIATION'].includes(l.status)) {
          const uid = Number(l.responsible_user_id);
          managerLeadsCount[uid] = (managerLeadsCount[uid] || 0) + 1;
        }
      });

      const managerOverdueTasksCount = {};
      overdueTaskItems.forEach(t => {
        if (t.managerId) {
          const uid = Number(t.managerId);
          managerOverdueTasksCount[uid] = (managerOverdueTasksCount[uid] || 0) + 1;
        }
      });

      managerWorkloads = activeSalesReps.map(m => {
        const uid = Number(m.id);
        const openLeadsCount = managerLeadsCount[uid] || 0;
        const overdueTasks = managerOverdueTasksCount[uid] || 0;
        const isExcluded = excludedSet.has(uid);
        const utilization = maxLimit > 0 ? Math.round((openLeadsCount / maxLimit) * 100) : 0;

        let status = 'NORMAL';
        if (isExcluded) {
          status = 'EXCLUDED';
        } else if (utilization >= 100) {
          status = 'OVERLOADED';
        } else if (utilization >= 80) {
          status = 'HIGH_LOAD';
        }

        return {
          id: uid,
          name: m.name,
          role: m.role,
          openLeadsCount,
          overdueTasksCount: overdueTasks,
          capacityLimit: maxLimit,
          capacityUtilizationPercent: utilization,
          isExcluded,
          status
        };
      });
    }

    return {
      timestamp: now.toISOString(),
      userRole: user.role,
      isSupervisor,
      summary: {
        unassignedLeadsCount: unassignedItems.length,
        noContactLeadsCount: noContactItems.length,
        overdueTasksCount: overdueTaskItems.length,
        staleLeadsCount: staleLeadItems.length,
        expiringReservationsCount: expiringReservations.length,
        highWorkloadManagersCount: managerWorkloads.filter(m => m.status === 'OVERLOADED' || m.status === 'HIGH_LOAD').length
      },
      drilldowns: {
        unassignedLeads: unassignedItems,
        noContactLeads: noContactItems,
        overdueTasks: overdueTaskItems,
        staleLeads: staleLeadItems,
        expiringReservations: expiringReservations,
        managerWorkloads
      }
    };
  }
}
