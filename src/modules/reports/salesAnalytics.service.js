import { getDB, getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { getBusinessDate } from '../../utils/businessTime.js';
import { parseOptionalBigInt } from '../../utils/idNormalizer.js';

export const LOST_REASON_LABELS = {
  PRICE: 'Высокая цена / бюджет',
  LOCATION: 'Не подошла локация / район',
  PAYMENT_TERMS: 'Не подошли условия рассрочки / ПВ',
  NO_RESPONSE: 'Клиент не выходит на связь',
  CHOSE_COMPETITOR: 'Выбрал конкурента',
  NOT_READY: 'Не готов покупать / передумал',
  OTHER: 'Другая причина'
};

export class SalesAnalyticsService {
  /**
   * Helper to verify role and enforce RBAC
   */
  static checkAccess(user) {
    if (!user) {
      throw new AppError('Пользователь не авторизован', 401);
    }
    if (user.role === 'FINANCE_MANAGER') {
      throw new AppError('Доступ к аналитике продаж запрещен для вашей роли', 403);
    }
  }

  /**
   * Helper to get database connection (uses service role for protected tables)
   */
  static getDatabase() {
    try {
      if (typeof getServiceDB === 'function') {
        const sdb = getServiceDB();
        if (sdb) return sdb;
      }
    } catch {
      // fallback to getDB
    }
    return getDB();
  }

  /**
   * ЭТАП 2: План и факт продаж с помесячным сравнением и изоляцией уровней
   */
  static async getPlanFactAnalytics(query = {}, user) {
    this.checkAccess(user);
    const db = this.getDatabase();
    const role = user.role;

    // RBAC: Sales Manager is strictly restricted to own data
    let managerIdFilter = query.managerId ? Number(query.managerId) : null;
    if (role === 'SALES_MANAGER') {
      managerIdFilter = Number(user.id);
    }

    const projectIdFilter = query.projectId ? Number(query.projectId) : null;
    const buildingIdFilter = query.buildingId ? Number(query.buildingId) : null;

    // Determine months to compare (default: 2026-08 to 2026-11)
    const availablePeriods = ['2026-08', '2026-09', '2026-10', '2026-11'];
    let selectedPeriods = availablePeriods;
    if (query.period && query.period !== 'ALL') {
      selectedPeriods = [query.period];
    } else if (query.periods) {
      selectedPeriods = Array.isArray(query.periods) ? query.periods : query.periods.split(',').map(s => s.trim());
    }

    // 1. Fetch raw plans (with fallback if table access is restricted)
    let allPlans = [];
    try {
      const { data: plansData, error: pErr } = await db.from('sales_plans').select('*');
      if (pErr) {
        console.warn('Notice: sales_plans query restricted or unavailable:', pErr.message);
      } else {
        allPlans = plansData || [];
      }
    } catch (err) {
      console.warn('Notice: sales_plans access error:', err.message);
    }

    // 2. Fetch all deals with hierarchy
    const { data: dealsData, error: dErr } = await db.from('deals').select(`
      id, contract_number, status, payment_type, currency, final_price_minor,
      deal_date, signed_at, cancelled_at, responsible_user_id,
      leads ( id, full_name, interested_project_id ),
      units (
        id, unit_number, area_m2_x100, price_per_m2_minor,
        floors ( id, floor_number, sections ( id, buildings ( id, name, project_id ) ) )
      )
    `);
    if (dErr) throw dErr;
    const allDeals = dealsData || [];

    // 3. Filter deals by Project, Building, Manager
    let filteredDeals = allDeals;
    if (projectIdFilter) {
      filteredDeals = filteredDeals.filter(d => {
        const pId = d.units?.floors?.sections?.buildings?.project_id || d.leads?.interested_project_id;
        return Number(pId) === projectIdFilter;
      });
    }
    if (buildingIdFilter) {
      filteredDeals = filteredDeals.filter(d => {
        const bId = d.units?.floors?.sections?.buildings?.id;
        return Number(bId) === buildingIdFilter;
      });
    }
    if (managerIdFilter) {
      filteredDeals = filteredDeals.filter(d => Number(d.responsible_user_id) === managerIdFilter);
    }

    // 4. Calculate Plan vs Fact per month
    // CRITICAL ARCHITECTURAL RULE:
    // DEPARTMENT, PROJECT, and BUILDING are different hierarchical view levels of the SAME target!
    // They must NEVER be summed together.
    const monthlyComparison = selectedPeriods.map(period => {
      // Find matching target plan strictly according to filter level
      let targetPlan = null;
      if (managerIdFilter) {
        targetPlan = allPlans.find(p => p.period === period && p.scope_type === 'MANAGER' && Number(p.manager_id) === managerIdFilter);
      } else if (buildingIdFilter) {
        targetPlan = allPlans.find(p => p.period === period && p.scope_type === 'BUILDING' && Number(p.building_id) === buildingIdFilter);
      } else if (projectIdFilter) {
        targetPlan = allPlans.find(p => p.period === period && p.scope_type === 'PROJECT' && Number(p.project_id) === projectIdFilter);
      } else {
        // Overall company/department view - select strictly DEPARTMENT plan, NEVER sum!
        targetPlan = allPlans.find(p => p.period === period && p.scope_type === 'DEPARTMENT');
      }

      const targetDeals = targetPlan ? Number(targetPlan.target_deals_count || 0) : 0;
      const targetVolumeMinor = targetPlan ? BigInt(targetPlan.target_volume_minor || 0) : 0n;
      const targetVolumeUsd = Number((Number(targetVolumeMinor) / 100).toFixed(2));
      const planStatus = targetPlan?.status || 'NOT_SET';

      // Actual SIGNED deals signed in this month
      const periodSignedDeals = filteredDeals.filter(d => {
        if (d.status !== 'SIGNED') return false;
        const signingDate = d.signed_at || d.deal_date;
        return signingDate && String(signingDate).substring(0, 7) === period;
      });

      // Active RESERVATIONS in this month (separate - never mixed with signed!)
      const periodReservedDeals = filteredDeals.filter(d => {
        if (d.status !== 'RESERVED') return false;
        const resDate = d.deal_date || d.signed_at;
        return resDate && String(resDate).substring(0, 7) === period;
      });

      // CANCELLED deals in this month
      const periodCancelledDeals = filteredDeals.filter(d => {
        if (d.status !== 'CANCELLED' && !d.cancelled_at) return false;
        const cancelDate = d.cancelled_at;
        return cancelDate && String(cancelDate).substring(0, 7) === period;
      });

      const actualDealsCount = periodSignedDeals.length;
      const actualVolumeMinor = periodSignedDeals.reduce((sum, d) => sum + BigInt(d.final_price_minor || 0), 0n);
      const actualVolumeUsd = Number((Number(actualVolumeMinor) / 100).toFixed(2));

      // Execution % and Deviations (Gap)
      const dealsExecutionPercent = targetDeals > 0
        ? Number(((actualDealsCount / targetDeals) * 100).toFixed(1))
        : (actualDealsCount > 0 ? 100 : 0);

      const volumeExecutionPercent = targetVolumeMinor > 0n
        ? Number(((Number(actualVolumeMinor) / Number(targetVolumeMinor)) * 100).toFixed(1))
        : (actualVolumeMinor > 0n ? 100 : 0);

      const dealsGap = actualDealsCount - targetDeals;
      const volumeGapUsd = Number((actualVolumeUsd - targetVolumeUsd).toFixed(2));

      // Reserved stats (reported for visibility, never mixed with signed)
      const reservedCount = periodReservedDeals.length;
      const reservedVolumeUsd = Number((periodReservedDeals.reduce((sum, d) => sum + (d.final_price_minor || 0), 0) / 100).toFixed(2));

      // Cancelled stats
      const cancelledCount = periodCancelledDeals.length;
      const cancelledVolumeUsd = Number((periodCancelledDeals.reduce((sum, d) => sum + (d.final_price_minor || 0), 0) / 100).toFixed(2));

      return {
        period,
        planStatus,
        target: {
          dealsCount: targetDeals,
          volumeUsd: targetVolumeUsd,
        },
        actual: {
          signedDealsCount: actualDealsCount,
          signedVolumeUsd: actualVolumeUsd,
          uniqueBuyersCount: new Set(periodSignedDeals.map(d => d.leads?.id).filter(Boolean)).size
        },
        execution: {
          dealsPercent: dealsExecutionPercent,
          volumePercent: volumeExecutionPercent,
          dealsGap,
          volumeGapUsd
        },
        pipelineSupplementary: {
          reservedCount,
          reservedVolumeUsd,
          cancelledCount,
          cancelledVolumeUsd
        }
      };
    });

    // Summary across all compared months
    const totalTargetDeals = monthlyComparison.reduce((s, m) => s + m.target.dealsCount, 0);
    const totalTargetVolumeUsd = Number(monthlyComparison.reduce((s, m) => s + m.target.volumeUsd, 0).toFixed(2));
    const totalActualDeals = monthlyComparison.reduce((s, m) => s + m.actual.signedDealsCount, 0);
    const totalActualVolumeUsd = Number(monthlyComparison.reduce((s, m) => s + m.actual.signedVolumeUsd, 0).toFixed(2));

    const totalDealsExecutionPercent = totalTargetDeals > 0
      ? Number(((totalActualDeals / totalTargetDeals) * 100).toFixed(1))
      : (totalActualDeals > 0 ? 100 : 0);

    const totalVolumeExecutionPercent = totalTargetVolumeUsd > 0
      ? Number(((totalActualVolumeUsd / totalTargetVolumeUsd) * 100).toFixed(1))
      : (totalActualVolumeUsd > 0 ? 100 : 0);

    return {
      filters: {
        periods: selectedPeriods,
        projectId: projectIdFilter,
        buildingId: buildingIdFilter,
        managerId: managerIdFilter
      },
      summary: {
        totalTargetDeals,
        totalTargetVolumeUsd,
        totalActualDeals,
        totalActualVolumeUsd,
        dealsExecutionPercent: totalDealsExecutionPercent,
        volumeExecutionPercent: totalVolumeExecutionPercent,
        dealsGap: totalActualDeals - totalTargetDeals,
        volumeGapUsd: Number((totalActualVolumeUsd - totalTargetVolumeUsd).toFixed(2))
      },
      monthlyComparison,
      isolationRuleNotice: 'DEPARTMENT, PROJECT and BUILDING plans are isolated representation tiers and are strictly NEVER summed together.'
    };
  }

  /**
   * ЭТАП 3: Сквозная воронка продаж полного цикла
   * Новый лид → В работе → Переговоры → Бронирование → Подписанный договор
   */
  static async getSalesFunnelAnalytics(query = {}, user) {
    this.checkAccess(user);
    const db = this.getDatabase();
    const role = user.role;

    let managerIdFilter = query.managerId ? Number(query.managerId) : null;
    if (role === 'SALES_MANAGER') {
      managerIdFilter = Number(user.id);
    }
    const projectIdFilter = query.projectId ? Number(query.projectId) : null;

    // Fetch leads
    let leadsQuery = db.from('leads').select(`
      id, full_name, phone, status, source, responsible_user_id, interested_project_id,
      lost_reason, created_at, updated_at
    `).is('archived_at', null);
    const { data: leadsData, error: lErr } = await leadsQuery;
    if (lErr) throw lErr;
    let leads = leadsData || [];

    // Fetch deals
    let dealsQuery = db.from('deals').select(`
      id, contract_number, status, payment_type, final_price_minor, deal_date, signed_at,
      cancelled_at, cancellation_reason, created_at, lead_id, unit_id, responsible_user_id,
      leads ( interested_project_id )
    `);
    const { data: dealsData, error: dErr } = await dealsQuery;
    if (dErr) throw dErr;
    let deals = dealsData || [];

    // Filter by project
    if (projectIdFilter) {
      leads = leads.filter(l => Number(l.interested_project_id) === projectIdFilter);
      deals = deals.filter(d => Number(d.leads?.interested_project_id) === projectIdFilter);
    }

    // Filter by manager (with self-scope for SALES_MANAGER)
    if (managerIdFilter) {
      leads = leads.filter(l => Number(l.responsible_user_id) === managerIdFilter);
      deals = deals.filter(d => Number(d.responsible_user_id) === managerIdFilter);
    }

    // 1. Unique Deals categorization
    const signedDeals = deals.filter(d => d.status === 'SIGNED');
    const reservedDeals = deals.filter(d => d.status === 'RESERVED');
    const cancelledDeals = deals.filter(d => d.status === 'CANCELLED' || Boolean(d.cancelled_at));

    // Unique clients in signed contracts
    const signedBuyerLeadIds = new Set(signedDeals.map(d => d.lead_id).filter(Boolean));
    // Unique clients in active reservations
    const reservedBuyerLeadIds = new Set(reservedDeals.map(d => d.lead_id).filter(Boolean));

    // 2. Stage counts (Zero double counting!)
    // Stage 1: New leads (status = NEW, not converted yet)
    const newLeads = leads.filter(l => l.status === 'NEW');
    // Stage 2: In progress (status = IN_PROGRESS)
    const inProgressLeads = leads.filter(l => l.status === 'IN_PROGRESS');
    // Stage 3: Negotiation (status = NEGOTIATION)
    const negotiationLeads = leads.filter(l => l.status === 'NEGOTIATION');
    // Stage 4: Active Reservations (unique reserved deals / leads)
    const reservedCount = reservedDeals.length;
    // Stage 5: Signed Contracts (unique signed deals / won leads)
    const signedContractsCount = signedDeals.length;

    // Total unique funnel volume
    const totalLeadsCount = leads.length;

    // Stage progression percentages
    const stages = [
      {
        id: 'NEW',
        name: 'Новый лид',
        count: newLeads.length,
        color: '#64748b',
        description: 'Первичное обращение, ожидание квалификации'
      },
      {
        id: 'IN_PROGRESS',
        name: 'В работе',
        count: inProgressLeads.length,
        color: '#3b82f6',
        description: 'Установлен контакт, подбор планировок'
      },
      {
        id: 'NEGOTIATION',
        name: 'Переговоры',
        count: negotiationLeads.length,
        color: '#f59e0b',
        description: 'Согласование условий, КП, встреча'
      },
      {
        id: 'RESERVED',
        name: 'Бронирование',
        count: reservedCount,
        color: '#06b6d4',
        volumeUsd: Number((reservedDeals.reduce((s, d) => s + (d.final_price_minor || 0), 0) / 100).toFixed(2)),
        description: 'Зафиксирована бронь на квартиру'
      },
      {
        id: 'SIGNED',
        name: 'Подписанный договор',
        count: signedContractsCount,
        color: '#10b981',
        volumeUsd: Number((signedDeals.reduce((s, d) => s + (d.final_price_minor || 0), 0) / 100).toFixed(2)),
        description: 'Договор подписан, открыта оплата'
      }
    ];

    // Cumulative progression calculation
    // Cumulative reached: how many reached at least this stage
    const reachedSigned = signedContractsCount;
    const reachedReserved = signedContractsCount + reservedCount;
    const reachedNegotiation = reachedReserved + negotiationLeads.length;
    const reachedInProgress = reachedNegotiation + inProgressLeads.length;
    const reachedNew = totalLeadsCount;

    stages[0].reachedCount = reachedNew;
    stages[1].reachedCount = reachedInProgress;
    stages[2].reachedCount = reachedNegotiation;
    stages[3].reachedCount = reachedReserved;
    stages[4].reachedCount = reachedSigned;

    // Stage-to-stage conversion rate
    stages[0].conversionFromPrev = 100;
    stages[1].conversionFromPrev = reachedNew > 0 ? Number(((reachedInProgress / reachedNew) * 100).toFixed(1)) : 0;
    stages[2].conversionFromPrev = reachedInProgress > 0 ? Number(((reachedNegotiation / reachedInProgress) * 100).toFixed(1)) : 0;
    stages[3].conversionFromPrev = reachedNegotiation > 0 ? Number(((reachedReserved / reachedNegotiation) * 100).toFixed(1)) : 0;
    stages[4].conversionFromPrev = reachedReserved > 0 ? Number(((reachedSigned / reachedReserved) * 100).toFixed(1)) : 0;

    // Overall conversion to signed contract
    const overallConversionPercent = totalLeadsCount > 0
      ? Number(((signedContractsCount / totalLeadsCount) * 100).toFixed(1))
      : 0;

    // 3. Average transition duration (Cycle time calculation)
    const transitionTimes = {
      leadToReserveDays: [],
      reserveToSignDays: [],
      totalLeadToSignDays: []
    };

    signedDeals.forEach(deal => {
      const lead = leads.find(l => l.id === deal.lead_id);
      const leadCreated = lead?.created_at ? new Date(lead.created_at).getTime() : null;
      const dealDate = deal.deal_date ? new Date(deal.deal_date).getTime() : null;
      const signedAt = deal.signed_at ? new Date(deal.signed_at).getTime() : (dealDate || null);

      if (leadCreated && dealDate && dealDate >= leadCreated) {
        const days = Math.round((dealDate - leadCreated) / (1000 * 60 * 60 * 24));
        transitionTimes.leadToReserveDays.push(days);
      }
      if (dealDate && signedAt && signedAt >= dealDate) {
        const days = Math.round((signedAt - dealDate) / (1000 * 60 * 60 * 24));
        transitionTimes.reserveToSignDays.push(days);
      }
      if (leadCreated && signedAt && signedAt >= leadCreated) {
        const days = Math.round((signedAt - leadCreated) / (1000 * 60 * 60 * 24));
        transitionTimes.totalLeadToSignDays.push(days);
      }
    });

    const avg = arr => arr.length > 0 ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)) : null;

    // DATA INTEGRITY GATE:
    // Do NOT show estimated intermediate transition times as actual facts when status transition history is absent.
    // Explicitly designate unavailable metrics.
    const transitionCycleAverages = {
      leadToReservationAvgDays: null,
      reservationToSigningAvgDays: null,
      fullCycleLeadToSignedAvgDays: transitionTimes.totalLeadToSignDays.length > 0
        ? avg(transitionTimes.totalLeadToSignDays)
        : null,
      metrics: {
        leadToReservation: {
          isAvailable: false,
          avgDays: null,
          notice: 'Журнал смены стадий лида не ведётся'
        },
        reservationToSigning: {
          isAvailable: false,
          avgDays: null,
          notice: 'Журнал перехода брони в подписание не ведётся'
        },
        fullCycleLeadToSigned: {
          isAvailable: transitionTimes.totalLeadToSignDays.length > 0,
          avgDays: transitionTimes.totalLeadToSignDays.length > 0 ? avg(transitionTimes.totalLeadToSignDays) : null,
          sampleCount: transitionTimes.totalLeadToSignDays.length,
          notice: transitionTimes.totalLeadToSignDays.length > 0
            ? `Рассчитано по выборке ${transitionTimes.totalLeadToSignDays.length} сделок`
            : 'Недостаточно данных'
        }
      }
    };

    // 4. Lost leads reasons breakdown
    const lostLeads = leads.filter(l => l.status === 'LOST');
    const lostReasonsMap = {};
    lostLeads.forEach(l => {
      const reasonKey = l.lost_reason || 'OTHER';
      lostReasonsMap[reasonKey] = (lostReasonsMap[reasonKey] || 0) + 1;
    });

    const lostReasons = Object.keys(lostReasonsMap).map(key => ({
      code: key,
      label: LOST_REASON_LABELS[key] || key,
      count: lostReasonsMap[key],
      percentOfLost: lostLeads.length > 0 ? Number(((lostReasonsMap[key] / lostLeads.length) * 100).toFixed(1)) : 0
    })).sort((a, b) => b.count - a.count);

    return {
      totalLeads: totalLeadsCount,
      totalSignedContracts: signedContractsCount,
      totalActiveReservations: reservedCount,
      totalLostLeads: lostLeads.length,
      overallConversionPercent,
      stages,
      transitionCycleAverages,
      lostReasons
    };
  }

  /**
   * ЭТАП 4: Расширенная эффективность менеджеров
   */
  static async getEnhancedManagerPerformance(query = {}, user) {
    this.checkAccess(user);
    const db = this.getDatabase();
    const role = user.role;
    const isSalesManager = role === 'SALES_MANAGER';

    const projectIdFilter = query.projectId && query.projectId !== 'ALL' ? Number(query.projectId) : null;
    const buildingIdFilter = query.buildingId && query.buildingId !== 'ALL' ? Number(query.buildingId) : null;
    const periodFilter = query.period && query.period !== 'ALL' ? String(query.period).trim() : null;
    const managerIdFilter = query.managerId && query.managerId !== 'ALL' ? Number(query.managerId) : null;

    // 1. Fetch Users
    const { data: usersData, error: uErr } = await db.from('users').select('id, name, email, role, is_active').order('id', { ascending: true });
    if (uErr) throw uErr;
    const allUsers = usersData || [];

    // Filter relevant managers
    let managers = allUsers.filter(u => {
      const isActive = u.is_active === 1 || u.is_active === true || u.is_active === '1' || u.is_active === undefined;
      if (!isActive) return false;
      if (['FINANCE_MANAGER', 'WAREHOUSE_MANAGER'].includes(u.role)) return false;
      return true;
    });

    // If SALES_MANAGER, strictly self-scope
    if (isSalesManager) {
      managers = managers.filter(u => Number(u.id) === Number(user.id));
    } else if (managerIdFilter) {
      managers = managers.filter(u => Number(u.id) === managerIdFilter);
    }

    // 2. Fetch Leads
    const { data: rawLeads, error: lErr } = await db.from('leads').select(`
      id, full_name, phone, status, responsible_user_id, interested_project_id, created_at, updated_at,
      lead_notes ( id ),
      tasks ( id, type, status )
    `).is('archived_at', null);
    if (lErr) throw lErr;
    let leads = rawLeads || [];
    if (projectIdFilter) {
      leads = leads.filter(l => Number(l.interested_project_id) === projectIdFilter);
    }

    // 3. Fetch Deals
    const { data: rawDeals, error: dErr } = await db.from('deals').select(`
      id, contract_number, status, final_price_minor, responsible_user_id, deal_date, signed_at, cancelled_at,
      units (
        id, unit_number,
        floors ( id, sections ( id, buildings ( id, project_id ) ) )
      )
    `);
    if (dErr) throw dErr;
    let deals = rawDeals || [];

    if (projectIdFilter) {
      deals = deals.filter(d => Number(d.units?.floors?.sections?.buildings?.project_id) === projectIdFilter);
    }
    if (buildingIdFilter) {
      deals = deals.filter(d => Number(d.units?.floors?.sections?.buildings?.id) === buildingIdFilter);
    }
    if (periodFilter) {
      deals = deals.filter(d => {
        const signingDate = d.signed_at || d.deal_date;
        return signingDate && String(signingDate).startsWith(periodFilter);
      });
    }

    // 4. Fetch Tasks
    const { data: rawTasks, error: tErr } = await db.from('tasks').select(`
      id, lead_id, deal_id, assigned_user_id, type, status, due_date, completed_at
    `);
    if (tErr) throw tErr;
    const tasks = rawTasks || [];

    const todayStr = getBusinessDate();

    // 5. Calculate KPI for each manager
    const managersKPI = managers.map(mgr => {
      const mid = Number(mgr.id);
      const mgrLeads = leads.filter(l => Number(l.responsible_user_id) === mid);
      const mgrDeals = deals.filter(d => Number(d.responsible_user_id) === mid);
      const mgrTasks = tasks.filter(t => Number(t.assigned_user_id) === mid);

      // Assigned leads
      const assignedLeadsCount = mgrLeads.length;

      // Processed vs Unprocessed leads
      // Processed = has notes, tasks, or deals, or status advanced beyond NEW
      let processedLeadsCount = 0;
      let unprocessedLeadsCount = 0;

      mgrLeads.forEach(l => {
        const hasNotes = Boolean(l.lead_notes && l.lead_notes.length > 0);
        const hasTasks = Boolean(l.tasks && l.tasks.length > 0);
        const hasAdvancedStatus = l.status !== 'NEW';
        if (hasNotes || hasTasks || hasAdvancedStatus) {
          processedLeadsCount++;
        } else {
          unprocessedLeadsCount++;
        }
      });

      // Overdue tasks
      const overdueTasksCount = mgrTasks.filter(t => t.status === 'OPEN' && t.due_date && t.due_date < todayStr).length;

      // Completed calls and meetings
      const completedCalls = mgrTasks.filter(t => t.type === 'CALL' && t.status === 'COMPLETED').length;
      const completedMeetings = mgrTasks.filter(t => t.type === 'MEETING' && t.status === 'COMPLETED').length;

      // Reservations & Signed Contracts
      const reservedDealsCount = mgrDeals.filter(d => d.status === 'RESERVED').length;
      const signedDeals = mgrDeals.filter(d => d.status === 'SIGNED');
      const signedDealsCount = signedDeals.length;

      // Sales Volume USD
      const salesVolumeMinor = signedDeals.reduce((sum, d) => sum + (d.final_price_minor || 0), 0);
      const salesVolumeUsd = Number((salesVolumeMinor / 100).toFixed(2));

      // Conversion %: signed deals / assigned leads
      const conversionRate = assignedLeadsCount > 0
        ? Number(((signedDealsCount / assignedLeadsCount) * 100).toFixed(1))
        : 0;

      return {
        managerId: mgr.id,
        name: mgr.name,
        email: mgr.email,
        role: mgr.role,
        assignedLeadsCount,
        processedLeadsCount,
        unprocessedLeadsCount,
        overdueTasksCount,
        completedCalls,
        completedMeetings,
        reservedDealsCount,
        signedDealsCount,
        salesVolumeUsd,
        conversionRate
      };
    });

    // Summary across active managers
    const teamSummary = {
      totalAssignedLeads: managersKPI.reduce((s, m) => s + m.assignedLeadsCount, 0),
      totalProcessedLeads: managersKPI.reduce((s, m) => s + m.processedLeadsCount, 0),
      totalUnprocessedLeads: managersKPI.reduce((s, m) => s + m.unprocessedLeadsCount, 0),
      totalOverdueTasks: managersKPI.reduce((s, m) => s + m.overdueTasksCount, 0),
      totalCompletedCalls: managersKPI.reduce((s, m) => s + m.completedCalls, 0),
      totalCompletedMeetings: managersKPI.reduce((s, m) => s + m.completedMeetings, 0),
      totalReservedDeals: managersKPI.reduce((s, m) => s + m.reservedDealsCount, 0),
      totalSignedDeals: managersKPI.reduce((s, m) => s + m.signedDealsCount, 0),
      totalSalesVolumeUsd: Number(managersKPI.reduce((s, m) => s + m.salesVolumeUsd, 0).toFixed(2)),
      overallConversionRate: managersKPI.reduce((s, m) => s + m.assignedLeadsCount, 0) > 0
        ? Number(((managersKPI.reduce((s, m) => s + m.signedDealsCount, 0) / managersKPI.reduce((s, m) => s + m.assignedLeadsCount, 0)) * 100).toFixed(1))
        : 0
    };

    return {
      isRestrictedToSelf: isSalesManager,
      teamSummary,
      managers: managersKPI
    };
  }

  /**
   * ЭТАП 5: Аналитика спроса на квартиры (lead_interested_units)
   */
  static async getApartmentDemandAnalytics(query = {}, user) {
    this.checkAccess(user);
    const db = this.getDatabase();

    const projectIdFilter = query.projectId ? Number(query.projectId) : null;
    const buildingIdFilter = query.buildingId ? Number(query.buildingId) : null;

    // Fetch interested units with strict state separation:
    // SUCCESS_WITH_DATA | SUCCESS_EMPTY | DATA_UNAVAILABLE
    let dataState = 'SUCCESS_EMPTY';
    let interests = [];

    try {
      const { data: interestsData, error: iErr } = await db.from('lead_interested_units').select(`
        id, lead_id, unit_id, priority, comment, next_contact_date, created_at,
        leads ( id, full_name, phone, status, responsible_user_id ),
        units (
          id, unit_number, rooms, area_m2_x100, price_per_m2_minor, manual_total_price_minor, status,
          floors (
            id, floor_number,
            sections (
              id,
              buildings ( id, name, code, project_id, projects ( id, name ) )
            )
          )
        )
      `);
      if (iErr) {
        // Technical error logged ONLY to secure server console, not exposed to client
        console.error('[SalesAnalytics Security/DB] lead_interested_units query restricted or unavailable:', {
          code: iErr.code,
          message: iErr.message,
          hint: iErr.hint
        });
        dataState = 'DATA_UNAVAILABLE';
      } else {
        interests = interestsData || [];
        dataState = interests.length > 0 ? 'SUCCESS_WITH_DATA' : 'SUCCESS_EMPTY';
      }
    } catch (err) {
      console.error('[SalesAnalytics Security/DB] lead_interested_units query exception:', err.message);
      dataState = 'DATA_UNAVAILABLE';
    }

    if (dataState === 'DATA_UNAVAILABLE') {
      return {
        state: 'DATA_UNAVAILABLE',
        isAvailable: false,
        message: 'Данные аналитики спроса временно недоступны',
        summary: {
          totalInterestsCount: 0,
          uniqueBuyersCount: 0
        },
        topDemandedUnits: [],
        demandByRooms: [],
        demandByFloors: [],
        demandByArea: [],
        demandByPrice: []
      };
    }

    // Filter by project & building
    if (projectIdFilter) {
      interests = interests.filter(i => {
        const pId = i.units?.floors?.sections?.buildings?.project_id;
        return Number(pId) === projectIdFilter;
      });
    }
    if (buildingIdFilter) {
      interests = interests.filter(i => {
        const bId = i.units?.floors?.sections?.buildings?.id;
        return Number(bId) === buildingIdFilter;
      });
    }

    // Filter to apartments only for Apartment Demand Analytics
    interests = interests.filter(i => !i.units?.unit_kind || i.units.unit_kind === 'APARTMENT');

    const totalInterestsCount = interests.length;
    const uniqueBuyersSet = new Set(interests.map(i => i.lead_id).filter(Boolean));
    const uniqueBuyersCount = uniqueBuyersSet.size;

    // 1. Most Demanded Apartments (Ranked by interests count)
    const unitMap = {};
    interests.forEach(i => {
      const u = i.units;
      if (!u) return;
      const uid = u.id;
      if (!unitMap[uid]) {
        const area = (u.area_m2_x100 || 0) / 100;
        let priceUsd = 0;
        if (u.manual_total_price_minor) {
          priceUsd = u.manual_total_price_minor / 100;
        } else if (u.price_per_m2_minor && area > 0) {
          priceUsd = Math.round((u.price_per_m2_minor / 100) * area);
        }

        unitMap[uid] = {
          unitId: uid,
          unitNumber: u.unit_number,
          rooms: u.rooms,
          areaM2: area,
          floorNumber: u.floors?.floor_number,
          buildingName: u.floors?.sections?.buildings?.name || 'Блок Б',
          projectName: u.floors?.sections?.buildings?.projects?.name || 'TOZON PLAZA',
          currentStatus: u.status,
          priceUsd,
          interestsCount: 0,
          uniqueBuyersCount: 0,
          buyersSet: new Set(),
          priorities: { HIGH: 0, MEDIUM: 0, LOW: 0 }
        };
      }
      unitMap[uid].interestsCount++;
      unitMap[uid].buyersSet.add(i.lead_id);
      if (unitMap[uid].priorities[i.priority] !== undefined) {
        unitMap[uid].priorities[i.priority]++;
      }
    });

    const topDemandedUnits = Object.values(unitMap).map(u => ({
      ...u,
      uniqueBuyersCount: u.buyersSet.size,
      buyersSet: undefined
    })).sort((a, b) => b.interestsCount - a.interestsCount);

    // 2. Demand by Rooms
    const roomsMap = { 1: 0, 2: 0, 3: 0, 4: 0 };
    const roomsBuyers = { 1: new Set(), 2: new Set(), 3: new Set(), 4: new Set() };
    interests.forEach(i => {
      const r = i.units?.rooms || 1;
      const key = r >= 4 ? 4 : r;
      roomsMap[key] = (roomsMap[key] || 0) + 1;
      if (i.lead_id) roomsBuyers[key].add(i.lead_id);
    });

    const demandByRooms = [1, 2, 3, 4].map(rooms => ({
      rooms: rooms === 4 ? '4+ комн.' : `${rooms}-комн.`,
      interestsCount: roomsMap[rooms] || 0,
      uniqueBuyersCount: roomsBuyers[rooms]?.size || 0,
      percentOfTotal: totalInterestsCount > 0 ? Number((((roomsMap[rooms] || 0) / totalInterestsCount) * 100).toFixed(1)) : 0
    }));

    // 3. Demand by Floors
    const floorMap = {};
    const floorBuyers = {};
    interests.forEach(i => {
      const fl = i.units?.floors?.floor_number;
      if (fl !== undefined && fl !== null) {
        floorMap[fl] = (floorMap[fl] || 0) + 1;
        if (!floorBuyers[fl]) floorBuyers[fl] = new Set();
        if (i.lead_id) floorBuyers[fl].add(i.lead_id);
      }
    });

    const demandByFloors = Object.keys(floorMap).map(Number).sort((a, b) => a - b).map(fl => ({
      floorNumber: fl,
      floorLabel: `Этаж ${fl}`,
      interestsCount: floorMap[fl],
      uniqueBuyersCount: floorBuyers[fl]?.size || 0,
      percentOfTotal: totalInterestsCount > 0 ? Number(((floorMap[fl] / totalInterestsCount) * 100).toFixed(1)) : 0
    }));

    // 4. Demand by Area Ranges
    const areaBands = [
      { id: 'under_50', label: '< 50 м²', min: 0, max: 50, count: 0, buyers: new Set() },
      { id: '50_to_70', label: '50 – 70 м²', min: 50, max: 70, count: 0, buyers: new Set() },
      { id: '70_to_90', label: '70 – 90 м²', min: 70, max: 90, count: 0, buyers: new Set() },
      { id: 'above_90', label: '> 90 м²', min: 90, max: 9999, count: 0, buyers: new Set() }
    ];

    interests.forEach(i => {
      const area = (i.units?.area_m2_x100 || 0) / 100;
      for (const band of areaBands) {
        if (area >= band.min && (band.max === 9999 ? true : area < band.max)) {
          band.count++;
          if (i.lead_id) band.buyers.add(i.lead_id);
          break;
        }
      }
    });

    const demandByArea = areaBands.map(b => ({
      id: b.id,
      label: b.label,
      interestsCount: b.count,
      uniqueBuyersCount: b.buyers.size,
      percentOfTotal: totalInterestsCount > 0 ? Number(((b.count / totalInterestsCount) * 100).toFixed(1)) : 0
    }));

    // 5. Demand by Price Ranges (USD)
    const priceBands = [
      { id: 'under_35k', label: '< $35 000', min: 0, max: 35000, count: 0, buyers: new Set() },
      { id: '35k_to_50k', label: '$35 000 – $50 000', min: 35000, max: 50000, count: 0, buyers: new Set() },
      { id: '50k_to_70k', label: '$50 000 – $70 000', min: 50000, max: 70000, count: 0, buyers: new Set() },
      { id: 'above_70k', label: '> $70 000', min: 70000, max: 999999999, count: 0, buyers: new Set() }
    ];

    interests.forEach(i => {
      const u = i.units;
      if (!u) return;
      const area = (u.area_m2_x100 || 0) / 100;
      let price = 0;
      if (u.manual_total_price_minor) {
        price = u.manual_total_price_minor / 100;
      } else if (u.price_per_m2_minor && area > 0) {
        price = Math.round((u.price_per_m2_minor / 100) * area);
      }

      for (const band of priceBands) {
        if (price >= band.min && (band.max === 999999999 ? true : price < band.max)) {
          band.count++;
          if (i.lead_id) band.buyers.add(i.lead_id);
          break;
        }
      }
    });

    const demandByPrice = priceBands.map(b => ({
      id: b.id,
      label: b.label,
      interestsCount: b.count,
      uniqueBuyersCount: b.buyers.size,
      percentOfTotal: totalInterestsCount > 0 ? Number(((b.count / totalInterestsCount) * 100).toFixed(1)) : 0
    }));

    const finalState = interests.length > 0 ? 'SUCCESS_WITH_DATA' : 'SUCCESS_EMPTY';

    return {
      state: finalState,
      isAvailable: true,
      message: null,
      summary: {
        totalInterestsCount,
        uniqueBuyersCount
      },
      topDemandedUnits,
      demandByRooms,
      demandByFloors,
      demandByArea,
      demandByPrice
    };
  }

  /**
   * ЭТАП 6: Экспорт аналитических таблиц в CSV (Excel-compatible with UTF-8 BOM)
   */
  static async exportSalesAnalyticsCsv(type = 'plan_fact', query = {}, user) {
    this.checkAccess(user);

    const normalizedType = String(type || 'plan_fact').replace(/-/g, '_');

    if (normalizedType === 'plan_fact') {
      const data = await this.getPlanFactAnalytics(query, user);
      let csv = '\uFEFFПериод;План (кв);Факт (кв);Выполнение (кв %);Отклонение (кв);План (USD);Факт (USD);Выполнение (USD %);Отклонение (USD);Брони (USD);Расторжения (USD)\r\n';
      data.monthlyComparison.forEach(m => {
        csv += `${m.period};${m.target.dealsCount};${m.actual.signedDealsCount};${m.execution.dealsPercent}%;${m.execution.dealsGap};${m.target.volumeUsd};${m.actual.signedVolumeUsd};${m.execution.volumePercent}%;${m.execution.volumeGapUsd};${m.pipelineSupplementary.reservedVolumeUsd};${m.pipelineSupplementary.cancelledVolumeUsd}\r\n`;
      });
      csv += `ИТОГО;${data.summary.totalTargetDeals};${data.summary.totalActualDeals};${data.summary.dealsExecutionPercent}%;${data.summary.dealsGap};${data.summary.totalTargetVolumeUsd};${data.summary.totalActualVolumeUsd};${data.summary.volumeExecutionPercent}%;${data.summary.volumeGapUsd};;\r\n`;
      return csv;
    }

    if (type === 'managers') {
      const data = await this.getEnhancedManagerPerformance(query, user);
      let csv = '\uFEFFМенеджер;Роль;Лиды (всего);Обработано;Не обработано;Просрочено задач;Звонки (факт);Встречи (факт);Брони;Договоры;Сумма продаж ($);Конверсия (%)\r\n';
      data.managers.forEach(m => {
        csv += `${m.name};${m.role};${m.assignedLeadsCount};${m.processedLeadsCount};${m.unprocessedLeadsCount};${m.overdueTasksCount};${m.completedCalls};${m.completedMeetings};${m.reservedDealsCount};${m.signedDealsCount};${m.salesVolumeUsd};${m.conversionRate}%\r\n`;
      });
      csv += `ИТОГО;;${data.teamSummary.totalAssignedLeads};${data.teamSummary.totalProcessedLeads};${data.teamSummary.totalUnprocessedLeads};${data.teamSummary.totalOverdueTasks};${data.teamSummary.totalCompletedCalls};${data.teamSummary.totalCompletedMeetings};${data.teamSummary.totalReservedDeals};${data.teamSummary.totalSignedDeals};${data.teamSummary.totalSalesVolumeUsd};${data.teamSummary.overallConversionRate}%\r\n`;
      return csv;
    }

    if (type === 'demand') {
      const data = await this.getApartmentDemandAnalytics(query, user);
      if (data.state === 'DATA_UNAVAILABLE') {
        return '\uFEFFСтатус;Сообщение\r\nНЕДОСТУПНО;Данные аналитики спроса временно недоступны\r\n';
      }
      let csv = '\uFEFFКвартира;Комнат;Площадь (м²);Этаж;Блок;Текущий статус;Цена ($);Сохранений интереса;Уникальных клиентов;Приоритет Высокий;Приоритет Средний;Приоритет Низкий\r\n';
      data.topDemandedUnits.forEach(u => {
        csv += `№${u.unitNumber};${u.rooms};${u.areaM2};${u.floorNumber};${u.buildingName};${u.currentStatus};${u.priceUsd};${u.interestsCount};${u.uniqueBuyersCount};${u.priorities.HIGH};${u.priorities.MEDIUM};${u.priorities.LOW}\r\n`;
      });
      return csv;
    }

    throw new AppError('Неизвестный тип экспорта: ' + type, 400);
  }
}
