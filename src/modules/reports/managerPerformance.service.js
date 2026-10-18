import { getDB, getServiceDB } from '../../db/connection.js';
import { parseOptionalBigInt } from '../../utils/idNormalizer.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { calculateWorkingMinutes, formatWorkingDuration, getBusinessDate, BUSINESS_TIMEZONE } from '../../utils/businessTime.js';

const getSecureDB = () => {
  try {
    if (typeof getServiceDB === 'function') {
      const sdb = getServiceDB();
      if (sdb) return sdb;
    }
  } catch {}
  return getDB();
};

export const LOST_REASON_LABELS = {
  PRICE: 'Высокая цена / бюджет',
  LOCATION: 'Не подошла локация / район',
  PAYMENT_TERMS: 'Не подошли условия рассрочки / ПВ',
  NO_RESPONSE: 'Клиент не выходит на связь',
  CHOSE_COMPETITOR: 'Выбрал конкурента',
  NOT_READY: 'Не готов покупать / передумал',
  OTHER: 'Другая причина'
};

/**
 * Resolves date range based on period key and business date in Asia/Dushanbe.
 */
export function resolveDateRange(periodKey = 'month', customStart = null, customEnd = null) {
  const todayStr = getBusinessDate();
  const [yStr, mStr, dStr] = todayStr.split('-');
  const year = parseInt(yStr, 10);
  const month = parseInt(mStr, 10); // 1-12
  const day = parseInt(dStr, 10);

  let startDate = `${todayStr}T00:00:00.000Z`;
  let endDate = `${todayStr}T23:59:59.999Z`;
  let label = 'Сегодня';

  switch (periodKey) {
    case 'today':
      startDate = `${todayStr}T00:00:00.000Z`;
      endDate = `${todayStr}T23:59:59.999Z`;
      label = 'Сегодня';
      break;

    case 'week': {
      // Find Monday of the current week
      const d = new Date(Date.UTC(year, month - 1, day));
      const dayOfWeek = d.getUTCDay(); // 0 is Sunday, 1 is Monday
      const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      d.setUTCDate(d.getUTCDate() + diffToMonday);
      const monStr = d.toISOString().split('T')[0];
      startDate = `${monStr}T00:00:00.000Z`;
      endDate = `${todayStr}T23:59:59.999Z`;
      label = 'Текущая неделя';
      break;
    }

    case 'month': {
      const startMonthStr = `${year}-${String(month).padStart(2, '0')}-01`;
      startDate = `${startMonthStr}T00:00:00.000Z`;
      endDate = `${todayStr}T23:59:59.999Z`;
      const monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
      label = `Текущий месяц (${monthNames[month - 1]} ${year})`;
      break;
    }

    case 'last_month': {
      let prevMonth = month - 1;
      let prevYear = year;
      if (prevMonth === 0) {
        prevMonth = 12;
        prevYear -= 1;
      }
      const lastDayPrev = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
      const startLastStr = `${prevYear}-${String(prevMonth).padStart(2, '0')}-01`;
      const endLastStr = `${prevYear}-${String(prevMonth).padStart(2, '0')}-${String(lastDayPrev).padStart(2, '0')}`;
      startDate = `${startLastStr}T00:00:00.000Z`;
      endDate = `${endLastStr}T23:59:59.999Z`;
      const monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
      label = `Прошлый месяц (${monthNames[prevMonth - 1]} ${prevYear})`;
      break;
    }

    case 'quarter': {
      const qMonthStart = Math.floor((month - 1) / 3) * 3 + 1;
      const startQuarterStr = `${year}-${String(qMonthStart).padStart(2, '0')}-01`;
      startDate = `${startQuarterStr}T00:00:00.000Z`;
      endDate = `${todayStr}T23:59:59.999Z`;
      const qNum = Math.floor((month - 1) / 3) + 1;
      label = `Q${qNum} ${year}`;
      break;
    }

    case 'year': {
      startDate = `${year}-01-01T00:00:00.000Z`;
      endDate = `${todayStr}T23:59:59.999Z`;
      label = `${year} год`;
      break;
    }

    case 'custom':
      if (customStart && customEnd) {
        startDate = `${customStart}T00:00:00.000Z`;
        endDate = `${customEnd}T23:59:59.999Z`;
        label = `${customStart} — ${customEnd}`;
      } else {
        startDate = '2026-01-01T00:00:00.000Z';
        endDate = `${todayStr}T23:59:59.999Z`;
        label = 'Все время';
      }
      break;

    case 'all':
    default:
      startDate = '2026-01-01T00:00:00.000Z';
      endDate = `${todayStr}T23:59:59.999Z`;
      label = 'Все время';
      break;
  }

  return {
    key: periodKey,
    label,
    startDate,
    endDate
  };
}

export class ManagerPerformanceService {
  /**
   * Main entry point for Manager Performance calculation.
   * Strictly enforces RBAC, data attribution, and safe cohort conversion.
   */
  static async getPerformanceData(filters = {}, currentUser) {
    if (!currentUser) {
      throw new AppError('Пользователь не авторизован', 401);
    }

    // RBAC: FINANCE_MANAGER strictly forbidden
    if (currentUser.role === 'FINANCE_MANAGER') {
      throw new AppError('Доступ к аналитике эффективности отдела продаж запрещен', 403);
    }

    const isSalesManager = currentUser.role === 'SALES_MANAGER';
    const isDirectorOrAdmin = ['ADMIN', 'DIRECTOR'].includes(currentUser.role);

    // Resolve target manager filter
    let requestedManagerId = filters.managerId || 'ALL';
    if (isSalesManager) {
      // Sales manager can strictly view ONLY own metrics
      requestedManagerId = String(currentUser.id);
    }

    const cleanProjectId = parseOptionalBigInt(filters.projectId);
    const dateRange = resolveDateRange(filters.period || 'all', filters.startDate, filters.endDate);
    const today = getBusinessDate();

    const db = getSecureDB();

    // 1. Fetch Users / Managers
    let rawUsers = null;
    try {
      const { data, error } = await db
        .from('users')
        .select('id, name, email, role, is_active, is_sales_rep')
        .order('id', { ascending: true });
      if (!error && data) rawUsers = data;
    } catch {
      // Fallback if is_sales_rep column not yet present
    }

    if (!rawUsers) {
      const { data: fbUsers, error: fbErr } = await db
        .from('users')
        .select('id, name, email, role, is_active')
        .order('id', { ascending: true });
      if (fbErr) throw fbErr;
      rawUsers = fbUsers || [];
    }

    const allUsers = rawUsers || [];
    // Only active sales representatives (exclude admins, directors, accountants, warehouse staff)
    const salesManagers = allUsers.filter(u => {
      const isActive = u.is_active === 1 || u.is_active === true || u.is_active === '1';
      if (!isActive) return false;
      if (['ADMIN', 'DIRECTOR', 'FINANCE_MANAGER', 'WAREHOUSE_MANAGER'].includes(u.role) && !u.is_sales_rep) {
        return false;
      }
      if (u.email === 'zavsklad@tozon.crm') return false;
      if (u.is_sales_rep !== undefined && u.is_sales_rep !== null) {
        return Boolean(u.is_sales_rep === true || u.is_sales_rep === 1 || u.is_sales_rep === 'true');
      }
      return u.role === 'SALES_MANAGER';
    });

    // 2. Fetch Leads with related signals
    const { data: rawLeads, error: leadsErr } = await db
      .from('leads')
      .select(`
        id,
        full_name,
        phone,
        status,
        source,
        responsible_user_id,
        interested_project_id,
        lost_reason,
        created_at,
        updated_at,
        archived_at,
        lead_notes ( id, author_user_id, created_at ),
        tasks ( id, title, type, status, due_date, completed_at, created_at ),
        deals ( id, status, contract_number, final_price_minor, responsible_user_id, cancelled_at )
      `)
      .is('archived_at', null);
    if (leadsErr) throw leadsErr;

    let leads = rawLeads || [];
    if (cleanProjectId) {
      leads = leads.filter(l => l.interested_project_id === cleanProjectId);
    }

    // 3. Fetch Deals
    const { data: rawDeals, error: dealsErr } = await db
      .from('deals')
      .select(`
        id,
        contract_number,
        lead_id,
        unit_id,
        responsible_user_id,
        status,
        currency,
        final_price_minor,
        deal_date,
        signed_at,
        cancelled_at,
        cancellation_reason,
        created_at,
        leads!lead_id ( id, full_name, interested_project_id )
      `);
    if (dealsErr) throw dealsErr;

    let deals = rawDeals || [];
    if (cleanProjectId) {
      deals = deals.filter(d => d.leads?.interested_project_id === cleanProjectId);
    }

    // 4. Fetch Tasks
    const { data: rawTasks, error: tasksErr } = await db
      .from('tasks')
      .select(`
        id,
        lead_id,
        deal_id,
        assigned_user_id,
        type,
        title,
        status,
        due_date,
        completed_at,
        created_at
      `);
    if (tasksErr) throw tasksErr;

    const tasks = rawTasks || [];

    // --- SYSTEM-WIDE METRICS (KPI 9: Unassigned Leads) ---
    const activeLeadsTotal = leads.filter(l => ['NEW', 'IN_PROGRESS', 'NEGOTIATION'].includes(l.status)).length;
    const unassignedActiveLeads = leads.filter(l => ['NEW', 'IN_PROGRESS', 'NEGOTIATION'].includes(l.status) && !l.responsible_user_id).length;
    const unassignedRatio = activeLeadsTotal > 0 ? Number(((unassignedActiveLeads / activeLeadsTotal) * 100).toFixed(1)) : 0;

    // --- HELPER TO COMPUTE KPI FOR A GIVEN MANAGER OR TEAM ---
    const computeManagerMetrics = (managerId, managerName) => {
      const isTeam = managerId === null;
      const mid = Number(managerId);

      // Attribution:
      // Leads attributed strictly to leads.responsible_user_id
      // Deals attributed strictly to deals.responsible_user_id
      // Tasks attributed strictly to tasks.assigned_user_id

      const mgrLeads = isTeam ? leads : leads.filter(l => l.responsible_user_id === mid);
      const mgrDeals = isTeam ? deals : deals.filter(d => d.responsible_user_id === mid);
      const mgrTasks = isTeam ? tasks : tasks.filter(t => t.assigned_user_id === mid);

      // KPI 1: Новые лиды, созданные за выбранный период
      const newLeadsPeriod = mgrLeads.filter(l => {
        if (!l.created_at) return false;
        const cTime = new Date(l.created_at).toISOString();
        return cTime >= dateRange.startDate && cTime <= dateRange.endDate;
      }).length;

      // KPI 2: Лиды в работе (Текущий активный портфель)
      const activeLeadsPortfolio = mgrLeads.filter(l => ['IN_PROGRESS', 'NEGOTIATION'].includes(l.status)).length;
      const currentNewQueue = mgrLeads.filter(l => l.status === 'NEW').length;

      // KPI 3: Действующие подписанные договоры (Verified Closed Deals)
      // Rule: status = SIGNED, contract_number is not null, cancelled_at IS NULL
      const activeSignedDeals = mgrDeals.filter(d => {
        const isSigned = d.status === 'SIGNED' && d.contract_number && !d.cancelled_at;
        if (!isSigned) return false;
        const dealTimestamp = d.signed_at || d.deal_date || d.created_at;
        if (!dealTimestamp) return false;
        const dTime = new Date(dealTimestamp).toISOString();
        return dTime >= dateRange.startDate && dTime <= dateRange.endDate;
      });

      const signedDealsCount = activeSignedDeals.length;
      const salesVolume = activeSignedDeals.reduce((acc, d) => acc + ((d.final_price_minor || 0) / 100), 0);

      // KPI 4: Количество расторгнутых договоров — отдельно
      const cancelledDeals = mgrDeals.filter(d => {
        const isCancelled = d.status === 'CANCELLED' || Boolean(d.cancelled_at);
        if (!isCancelled) return false;
        const cTimestamp = d.cancelled_at || d.created_at;
        if (!cTimestamp) return false;
        const cTime = new Date(cTimestamp).toISOString();
        return cTime >= dateRange.startDate && cTime <= dateRange.endDate;
      });
      const cancelledDealsCount = cancelledDeals.length;

      // KPI 5: Конверсия уникальных лидов в действующие подписанные договоры
      // Strict rule: only comparable cohort with unambiguous link between lead and deal
      // Cohort: Leads created in the period assigned to this manager
      const cohortLeads = mgrLeads.filter(l => {
        if (!l.created_at) return false;
        const cTime = new Date(l.created_at).toISOString();
        return cTime >= dateRange.startDate && cTime <= dateRange.endDate;
      });

      let cohortConversionRate = null;
      let cohortConversionLabel = 'Недостаточно данных';

      if (cohortLeads.length > 0) {
        // Count how many unique leads in this cohort resulted in a verified SIGNED deal
        const convertedLeads = cohortLeads.filter(l => {
          const leadDeals = l.deals || [];
          return leadDeals.some(d => d.status === 'SIGNED' && d.contract_number && !d.cancelled_at);
        });

        const rate = (convertedLeads.length / cohortLeads.length) * 100;
        cohortConversionRate = Number(rate.toFixed(1));
        cohortConversionLabel = `${cohortConversionRate}%`;
      }

      // KPI 6: Среднее время первого зафиксированного действия (CRM Activity Indicator)
      // Calculated in business working minutes (08:00 - 20:00 Asia/Dushanbe)
      const leadsForFirstAction = mgrLeads.filter(l => {
        if (!l.created_at) return false;
        const cTime = new Date(l.created_at).toISOString();
        return cTime >= dateRange.startDate && cTime <= dateRange.endDate;
      });

      const firstActionMinutesList = [];
      leadsForFirstAction.forEach(l => {
        // Collect signals: notes, tasks, deals
        const signals = [];
        (l.lead_notes || []).forEach(n => signals.push(new Date(n.created_at).getTime()));
        (l.tasks || []).forEach(t => {
          if (t.created_at) signals.push(new Date(t.created_at).getTime());
          if (t.completed_at) signals.push(new Date(t.completed_at).getTime());
        });
        (l.deals || []).forEach(d => {
          if (d.created_at) signals.push(new Date(d.created_at).getTime());
        });

        if (signals.length > 0) {
          const earliestSignal = Math.min(...signals);
          const workingMins = calculateWorkingMinutes(l.created_at, new Date(earliestSignal));
          firstActionMinutesList.push(workingMins);
        }
      });

      let avgFirstActionMinutes = null;
      let avgFirstActionLabel = 'Нет действий в CRM';
      if (firstActionMinutesList.length > 0) {
        const totalMins = firstActionMinutesList.reduce((acc, v) => acc + v, 0);
        avgFirstActionMinutes = Math.round(totalMins / firstActionMinutesList.length);
        avgFirstActionLabel = `${formatWorkingDuration(avgFirstActionMinutes)} (активность в CRM)`;
      }

      // KPI 7: Задачи (выполненные вовремя, просроченные, дисциплина)
      // Tasks completed in period:
      const completedTasksInPeriod = mgrTasks.filter(t => {
        if (t.status !== 'COMPLETED' || !t.completed_at) return false;
        const cTime = new Date(t.completed_at).toISOString();
        return cTime >= dateRange.startDate && cTime <= dateRange.endDate;
      });

      let tasksCompletedOnTime = 0;
      let tasksCompletedLate = 0;

      completedTasksInPeriod.forEach(t => {
        if (!t.due_date) {
          tasksCompletedOnTime++;
          return;
        }
        // Format completed_at in Asia/Dushanbe date YYYY-MM-DD
        const completedDateStr = new Intl.DateTimeFormat('en-CA', {
          timeZone: BUSINESS_TIMEZONE,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        }).format(new Date(t.completed_at));

        if (completedDateStr <= t.due_date) {
          tasksCompletedOnTime++;
        } else {
          tasksCompletedLate++;
        }
      });

      // Currently open overdue tasks
      const tasksCurrentlyOverdue = mgrTasks.filter(t => t.status === 'OPEN' && t.due_date && t.due_date < today).length;
      const tasksOpenOnTrack = mgrTasks.filter(t => t.status === 'OPEN' && (!t.due_date || t.due_date >= today)).length;

      const totalTaskAudited = tasksCompletedOnTime + tasksCompletedLate + tasksCurrentlyOverdue;
      let taskDisciplineRate = null;
      let taskDisciplineLabel = 'Нет задач';
      if (totalTaskAudited > 0) {
        taskDisciplineRate = Number(((tasksCompletedOnTime / totalTaskAudited) * 100).toFixed(1));
        taskDisciplineLabel = `${taskDisciplineRate}%`;
      }

      // KPI 8: Потерянные лиды с причинами отказа
      const lostLeadsInPeriod = mgrLeads.filter(l => {
        if (l.status !== 'LOST') return false;
        const uTime = new Date(l.updated_at || l.created_at).toISOString();
        return uTime >= dateRange.startDate && uTime <= dateRange.endDate;
      });
      const lostLeadsCount = lostLeadsInPeriod.length;

      const lostReasonsCounts = {};
      lostLeadsInPeriod.forEach(l => {
        const reasonKey = l.lost_reason || 'OTHER';
        lostReasonsCounts[reasonKey] = (lostReasonsCounts[reasonKey] || 0) + 1;
      });

      const lostReasonsBreakdown = Object.keys(lostReasonsCounts).map(code => ({
        code,
        label: LOST_REASON_LABELS[code] || code,
        count: lostReasonsCounts[code],
        pct: lostLeadsCount > 0 ? Number(((lostReasonsCounts[code] / lostLeadsCount) * 100).toFixed(1)) : 0
      })).sort((a, b) => b.count - a.count);

      return {
        managerId,
        managerName: managerName || (isTeam ? 'Вся команда' : 'Менеджер'),
        kpi: {
          newLeadsPeriod,
          activeLeadsPortfolio,
          currentNewQueue,
          signedDealsCount,
          salesVolume: Number(salesVolume.toFixed(2)),
          cancelledDealsCount,
          cohortConversionRate,
          cohortConversionLabel,
          cohortLeadsCount: cohortLeads.length,
          avgFirstActionMinutes,
          avgFirstActionLabel,
          tasksCompletedOnTime,
          tasksCompletedLate,
          tasksCurrentlyOverdue,
          tasksOpenOnTrack,
          taskDisciplineRate,
          taskDisciplineLabel,
          lostLeadsCount,
          lostReasonsBreakdown
        },
        drilldownUrls: {
          activeLeads: isTeam ? '/leads?tab=control' : `/leads?tab=control&responsibleUserId=${mid}`,
          newLeads: isTeam ? '/leads?status=NEW' : `/leads?status=NEW&responsibleUserId=${mid}`,
          signedDeals: isTeam ? '/deals?status=SIGNED' : `/deals?responsibleUserId=${mid}&status=SIGNED`,
          cancelledDeals: isTeam ? '/deals?status=CANCELLED' : `/deals?responsibleUserId=${mid}&status=CANCELLED`,
          tasksOverdue: isTeam ? '/tasks?filter=overdue' : `/tasks?filter=overdue&assignedTo=${mid}`,
          lostLeads: isTeam ? '/leads?status=LOST' : `/leads?status=LOST&responsibleUserId=${mid}`
        }
      };
    };

    // Calculate Summary (Total Team)
    const summary = computeManagerMetrics(null, 'Отдел продаж (Все сотрудники)');

    // Calculate breakdown per manager
    let targetManagers = salesManagers;
    if (requestedManagerId !== 'ALL') {
      const targetId = Number(requestedManagerId);
      targetManagers = salesManagers.filter(u => u.id === targetId);
    }

    const managersList = targetManagers.map(u => {
      const res = computeManagerMetrics(u.id, u.name);
      return {
        id: u.id,
        name: u.name,
        role: u.role,
        email: u.email,
        kpi: res.kpi,
        drilldownUrls: res.drilldownUrls
      };
    });

    // Sales Funnel Aggregation
    const funnelStages = [
      { status: 'NEW', label: 'Новый / В очереди', count: 0, color: '#38bdf8' },
      { status: 'IN_PROGRESS', label: 'Консультация / В работе', count: 0, color: '#6366f1' },
      { status: 'NEGOTIATION', label: 'Переговоры / Бронь', count: 0, color: '#f59e0b' },
      { status: 'SIGNED', label: 'Подписан договор', count: 0, color: '#10b981' },
      { status: 'LOST', label: 'Отказ', count: 0, color: '#f43f5e' }
    ];

    leads.forEach(l => {
      const s = l.status || 'NEW';
      const f = funnelStages.find(stage => stage.status === s);
      if (f) f.count++;
    });

    // Also populate SIGNED count from verified deals
    const verifiedSignedTotal = deals.filter(d => d.status === 'SIGNED' && d.contract_number && !d.cancelled_at).length;
    const signedFunnel = funnelStages.find(s => s.status === 'SIGNED');
    if (signedFunnel) {
      signedFunnel.count = verifiedSignedTotal;
    }

    return {
      period: dateRange,
      filter: {
        managerId: requestedManagerId,
        projectId: cleanProjectId || 'ALL'
      },
      userRole: currentUser.role,
      isRestrictedToSelf: isSalesManager,
      systemWide: {
        activeLeadsTotal,
        unassignedActiveLeads,
        unassignedRatio,
        unassignedLabel: `${unassignedRatio}%`
      },
      summary: summary.kpi,
      summaryDrilldown: summary.drilldownUrls,
      managers: managersList,
      funnel: funnelStages,
      lostReasons: summary.kpi.lostReasonsBreakdown
    };
  }
}
