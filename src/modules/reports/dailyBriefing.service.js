import { getDB, getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { getBusinessDate } from '../../utils/businessTime.js';

const getSecureDB = () => {
  try {
    if (typeof getServiceDB === 'function') {
      const sdb = getServiceDB();
      if (sdb) return sdb;
    }
  } catch {}
  return getDB();
};

export class DailyBriefingService {
  /**
   * Helper to verify role and enforce RBAC
   */
  static checkAccess(user) {
    if (!user) {
      throw new AppError('Пользователь не авторизован', 401);
    }
    if (['FINANCE_MANAGER', 'WAREHOUSE_MANAGER'].includes(user.role)) {
      throw new AppError('Доступ к ежедневной сводке продаж запрещен для вашей роли', 403);
    }
  }

  /**
   * Generates Daily Briefing Report for sales management
   * @param {Object} query - { date, projectId, buildingId, managerId }
   * @param {Object} user - Authenticated user object
   */
  static async getDailyBriefing(query = {}, user) {
    this.checkAccess(user);

    const db = getSecureDB();
    const isSupervisor = ['ADMIN', 'DIRECTOR'].includes(user.role);
    const userId = Number(user.id);

    // Date validation (Asia/Dushanbe calendar day)
    const targetDate = query.date ? String(query.date).trim() : getBusinessDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      throw new AppError('Неверный формат даты. Ожидается формат YYYY-MM-DD', 400);
    }

    const projectIdFilter = query.projectId && query.projectId !== 'ALL' ? Number(query.projectId) : null;
    const buildingIdFilter = query.buildingId && query.buildingId !== 'ALL' ? Number(query.buildingId) : null;
    let managerIdFilter = query.managerId && query.managerId !== 'ALL' ? Number(query.managerId) : null;

    if (!isSupervisor) {
      // Sales managers are strictly restricted to their own data
      managerIdFilter = userId;
    }

    // 1. Fetch Users
    const { data: rawUsers, error: uErr } = await db
      .from('users')
      .select('id, name, email, role, is_active')
      .order('id', { ascending: true });
    if (uErr) {
      console.error('[DailyBriefingService] Error fetching users:', uErr.message);
      throw new AppError('Ошибка при получении списка пользователей', 500);
    }
    const allUsers = rawUsers || [];

    // Exclude strictly non-sales, non-management operational roles
    const excludedRoles = ['FINANCE_MANAGER', 'WAREHOUSE_MANAGER', 'CASHIER'];
    const activeUsers = allUsers.filter(u => {
      const isActive = u.is_active === 1 || u.is_active === true || u.is_active === '1' || u.is_active === undefined;
      return isActive && !excludedRoles.includes(u.role);
    });

    const salesManagers = activeUsers.filter(u => u.role === 'SALES_MANAGER');
    const managementUsers = activeUsers.filter(u => ['ADMIN', 'DIRECTOR'].includes(u.role));

    let salesReps = [];
    if (!isSupervisor) {
      salesReps = salesManagers.filter(u => Number(u.id) === userId);
    } else if (managerIdFilter) {
      salesReps = activeUsers.filter(u => Number(u.id) === managerIdFilter);
    } else {
      // For supervisors, list sales managers first, followed by management users
      salesReps = [...salesManagers, ...managementUsers];
    }

    // 2. Fetch Leads
    let leadsQuery = db
      .from('leads')
      .select(`
        id, full_name, phone, source, status, responsible_user_id,
        interested_project_id, created_at, updated_at,
        users!responsible_user_id ( id, name, role )
      `)
      .is('archived_at', null);

    if (!isSupervisor) {
      leadsQuery = leadsQuery.eq('responsible_user_id', userId);
    } else if (managerIdFilter) {
      leadsQuery = leadsQuery.eq('responsible_user_id', managerIdFilter);
    }

    const { data: rawLeads, error: lErr } = await leadsQuery;
    if (lErr) {
      console.error('[DailyBriefingService] Error fetching leads:', lErr.message);
      throw new AppError('Ошибка при получении лидов', 500);
    }
    let allLeads = rawLeads || [];
    if (projectIdFilter) {
      allLeads = allLeads.filter(l => Number(l.interested_project_id) === projectIdFilter);
    }

    // Filter leads created on targetDate in Asia/Dushanbe
    const newLeadsDrilldown = allLeads.filter(l => {
      return getBusinessDate(l.created_at) === targetDate;
    }).map(l => ({
      id: l.id,
      fullName: l.full_name || 'Не указано',
      phone: l.phone || '',
      source: l.source || 'Прямой контакт',
      status: l.status,
      managerId: l.responsible_user_id,
      managerName: l.users?.name || 'Не назначен',
      createdAt: l.created_at
    }));

    // 3. Fetch Tasks
    let tasksQuery = db
      .from('tasks')
      .select(`
        id, lead_id, deal_id, assigned_user_id, created_by,
        type, title, description, client_name, phone,
        due_date, priority, status, completed_at, updated_at, created_at,
        users!assigned_user_id ( id, name )
      `);

    if (!isSupervisor) {
      tasksQuery = tasksQuery.eq('assigned_user_id', userId);
    } else if (managerIdFilter) {
      tasksQuery = tasksQuery.eq('assigned_user_id', managerIdFilter);
    }

    const { data: rawTasks, error: tErr } = await tasksQuery;
    let allTasks = [];
    let isTasksRestricted = false;
    if (tErr) {
      if (tErr.code === '42501' || tErr.message?.includes('permission denied')) {
        console.warn('[DailyBriefingService] Notice: tasks query restricted by RLS without service role:', tErr.message);
        isTasksRestricted = true;
      } else {
        console.error('[DailyBriefingService] Error fetching tasks:', tErr.message);
        throw new AppError('Ошибка при получении задач', 500);
      }
    } else {
      allTasks = rawTasks || [];
    }

    // Rule: "Не считать запланированные звонки выполненными" -> status strictly COMPLETED
    const completedCallsDrilldown = allTasks.filter(t => {
      if (t.type !== 'CALL') return false;
      if (t.status !== 'COMPLETED') return false;
      const completionDate = t.completed_at || t.updated_at;
      return getBusinessDate(completionDate) === targetDate;
    }).map(t => ({
      id: t.id,
      leadId: t.lead_id,
      dealId: t.deal_id,
      type: t.type,
      title: t.title,
      clientName: t.client_name || 'Клиент',
      phone: t.phone || '',
      managerId: t.assigned_user_id,
      managerName: t.users?.name || 'Менеджер',
      completedAt: t.completed_at || t.updated_at,
      priority: t.priority
    }));

    const completedMeetingsDrilldown = allTasks.filter(t => {
      if (t.type !== 'MEETING') return false;
      if (t.status !== 'COMPLETED') return false;
      const completionDate = t.completed_at || t.updated_at;
      return getBusinessDate(completionDate) === targetDate;
    }).map(t => ({
      id: t.id,
      leadId: t.lead_id,
      dealId: t.deal_id,
      type: t.type,
      title: t.title,
      clientName: t.client_name || 'Клиент',
      phone: t.phone || '',
      managerId: t.assigned_user_id,
      managerName: t.users?.name || 'Менеджер',
      completedAt: t.completed_at || t.updated_at,
      priority: t.priority
    }));

    // Overdue tasks: OPEN tasks with due_date strictly before targetDate (or current business date)
    const overdueTasksDrilldown = allTasks.filter(t => {
      if (t.status !== 'OPEN') return false;
      if (!t.due_date) return false;
      return t.due_date < targetDate;
    }).map(t => ({
      id: t.id,
      leadId: t.lead_id,
      dealId: t.deal_id,
      type: t.type,
      title: t.title,
      clientName: t.client_name || 'Клиент',
      phone: t.phone || '',
      managerId: t.assigned_user_id,
      managerName: t.users?.name || 'Менеджер',
      dueDate: t.due_date,
      priority: t.priority
    }));

    // 4. Fetch Deals
    let dealsQuery = db
      .from('deals')
      .select(`
        id, contract_number, lead_id, unit_id, responsible_user_id,
        status, payment_type, currency, final_price_minor,
        reservation_expires_at, deal_date, signed_at, cancelled_at, created_at,
        leads ( id, full_name, phone ),
        units (
          id, unit_number, unit_kind, rooms, area_m2_x100, price_per_m2_minor,
          floors (
            id, floor_number,
            sections (
              id, name,
              buildings ( id, name, project_id, projects ( id, name ) )
            )
          )
        ),
        users!responsible_user_id ( id, name )
      `);

    if (!isSupervisor) {
      dealsQuery = dealsQuery.eq('responsible_user_id', userId);
    } else if (managerIdFilter) {
      dealsQuery = dealsQuery.eq('responsible_user_id', managerIdFilter);
    }

    const { data: rawDeals, error: dErr } = await dealsQuery;
    if (dErr) {
      console.error('[DailyBriefingService] Error fetching deals:', dErr.message);
      throw new AppError('Ошибка при получении сделок', 500);
    }
    let allDeals = rawDeals || [];

    // Filter by project / building if requested
    if (projectIdFilter) {
      allDeals = allDeals.filter(d => Number(d.units?.floors?.sections?.buildings?.project_id) === projectIdFilter);
    }
    if (buildingIdFilter) {
      allDeals = allDeals.filter(d => Number(d.units?.floors?.sections?.buildings?.id) === buildingIdFilter);
    }

    // New Reservations on targetDate (status = RESERVED)
    // Rule: "Не смешивать бронирования с подписанными договорами"
    const newReservationsDrilldown = allDeals.filter(d => {
      if (d.status !== 'RESERVED') return false;
      const resDate = d.created_at ? getBusinessDate(d.created_at) : (d.deal_date ? d.deal_date.slice(0, 10) : null);
      return resDate === targetDate;
    }).map(d => {
      const areaM2 = (d.units?.area_m2_x100 || 0) / 100;
      const volumeMinor = d.final_price_minor || 0;
      return {
        id: d.id,
        contractNumber: d.contract_number ? `№${d.contract_number}` : `Бронь #${d.id}`,
        leadId: d.lead_id,
        clientName: d.leads?.full_name || 'Клиент',
        phone: d.leads?.phone || '',
        unitNumber: d.units?.unit_number || '—',
        rooms: d.units?.rooms,
        areaM2,
        buildingName: d.units?.floors?.sections?.buildings?.name || '—',
        projectName: d.units?.floors?.sections?.buildings?.projects?.name || '—',
        finalPriceMinor: volumeMinor,
        finalPriceUsd: Number((volumeMinor / 100).toFixed(2)),
        currency: d.currency || 'USD',
        reservationExpiresAt: d.reservation_expires_at,
        managerId: d.responsible_user_id,
        managerName: d.users?.name || 'Менеджер',
        dealDate: d.deal_date || d.created_at
      };
    });

    // Signed Contracts on targetDate (status = SIGNED / CONTRACTED / COMPLETED)
    // Rule: "Не включать отменённые и расторгнутые сделки в действующий факт продаж"
    const signedDealsDrilldown = allDeals.filter(d => {
      if (!['SIGNED', 'CONTRACTED', 'COMPLETED'].includes(d.status) || d.status === 'CANCELLED') return false;
      const signingDate = d.signed_at ? getBusinessDate(d.signed_at) : (d.deal_date ? d.deal_date.slice(0, 10) : null);
      return signingDate === targetDate;
    }).map(d => {
      const areaM2 = (d.units?.area_m2_x100 || 0) / 100;
      const volumeMinor = d.final_price_minor || 0;
      return {
        id: d.id,
        contractNumber: d.contract_number ? `№${d.contract_number}` : `Договор #${d.id}`,
        leadId: d.lead_id,
        clientName: d.leads?.full_name || 'Клиент',
        phone: d.leads?.phone || '',
        unitNumber: d.units?.unit_number || '—',
        rooms: d.units?.rooms,
        areaM2,
        buildingName: d.units?.floors?.sections?.buildings?.name || '—',
        projectName: d.units?.floors?.sections?.buildings?.projects?.name || '—',
        finalPriceMinor: volumeMinor,
        finalPriceUsd: Number((volumeMinor / 100).toFixed(2)),
        currency: d.currency || 'USD',
        managerId: d.responsible_user_id,
        managerName: d.users?.name || 'Менеджер',
        signedAt: d.signed_at || d.deal_date
      };
    });

    // Cancelled deals on targetDate (status = CANCELLED) - explicitly tracked separately
    const cancelledDealsDrilldown = allDeals.filter(d => {
      if (d.status !== 'CANCELLED') return false;
      const cancelDate = d.cancelled_at ? getBusinessDate(d.cancelled_at) : (d.updated_at ? getBusinessDate(d.updated_at) : (d.deal_date ? d.deal_date.slice(0, 10) : null));
      return cancelDate === targetDate;
    }).map(d => {
      const areaM2 = (d.units?.area_m2_x100 || 0) / 100;
      const volumeMinor = d.final_price_minor || 0;
      return {
        id: d.id,
        contractNumber: d.contract_number ? `№${d.contract_number}` : `Сделка #${d.id}`,
        leadId: d.lead_id,
        clientName: d.leads?.full_name || 'Клиент',
        phone: d.leads?.phone || '',
        unitNumber: d.units?.unit_number || '—',
        areaM2,
        finalPriceMinor: volumeMinor,
        finalPriceUsd: Number((volumeMinor / 100).toFixed(2)),
        currency: d.currency || 'USD',
        cancellationReason: d.cancellation_reason || 'Не указана',
        managerId: d.responsible_user_id,
        managerName: d.users?.name || 'Менеджер',
        cancelledAt: d.cancelled_at || d.updated_at
      };
    });

    // 5. Fetch Posted / Active Payments on targetDate
    // Rule: "Не смешивать стоимость договоров с фактически полученными платежами"
    // Rule: "Исключать аннулированные платежи (status = VOIDED / REVERSED) и платежи без deal_id"
    let paymentsQuery = db
      .from('payments')
      .select(`
        id, deal_id, amount_minor, payment_date, method, reference, comment,
        currency, payer_name, status, created_at,
        deals (
          id, contract_number, responsible_user_id,
          leads ( id, full_name, phone ),
          units (
            unit_number,
            floors ( sections ( buildings ( id, name, project_id ) ) )
          )
        )
      `)
      .neq('status', 'VOIDED');

    const { data: rawPayments, error: pErr } = await paymentsQuery;
    if (pErr) {
      console.error('[DailyBriefingService] Error fetching payments:', pErr.message);
      throw new AppError('Ошибка при получении платежей', 500);
    }
    let allPayments = rawPayments || [];

    // Filter payments linked to real deals and confirmed status
    allPayments = allPayments.filter(p => {
      if (!p.deal_id) return false;
      const status = String(p.status || '').toUpperCase().trim();
      if (['VOIDED', 'REVERSED', 'CANCELLED', 'DRAFT', 'PENDING'].includes(status)) return false;
      const validStatuses = ['ACTIVE', 'POSTED'];
      return validStatuses.includes(status);
    });

    // Filter by project / building if requested
    if (projectIdFilter) {
      allPayments = allPayments.filter(p => Number(p.deals?.units?.floors?.sections?.buildings?.project_id) === projectIdFilter);
    }
    if (buildingIdFilter) {
      allPayments = allPayments.filter(p => Number(p.deals?.units?.floors?.sections?.buildings?.id) === buildingIdFilter);
    }
    if (!isSupervisor) {
      allPayments = allPayments.filter(p => Number(p.deals?.responsible_user_id) === userId);
    } else if (managerIdFilter) {
      allPayments = allPayments.filter(p => Number(p.deals?.responsible_user_id) === managerIdFilter);
    }

    const postedPaymentsDrilldown = allPayments.filter(p => {
      const pDate = p.payment_date ? p.payment_date.slice(0, 10) : getBusinessDate(p.created_at);
      return pDate === targetDate;
    }).map(p => ({
      id: p.id,
      dealId: p.deal_id,
      contractNumber: p.deals?.contract_number ? `№${p.deals.contract_number}` : `Сделка #${p.deal_id}`,
      clientName: p.payer_name || p.deals?.leads?.full_name || 'Плательщик',
      phone: p.deals?.leads?.phone || '',
      unitNumber: p.deals?.units?.unit_number || '—',
      amountMinor: p.amount_minor || 0,
      amountFormatted: Number(((p.amount_minor || 0) / 100).toFixed(2)),
      currency: p.currency || 'USD',
      method: p.method || 'CASH',
      reference: p.reference || '',
      paymentDate: p.payment_date || targetDate,
      managerId: p.deals?.responsible_user_id,
      createdAt: p.created_at
    }));

    // Multi-currency calculation: Rule "Не складывать USD и TJS без подтверждённой методики пересчёта"
    const usdCollectedMinor = postedPaymentsDrilldown
      .filter(p => p.currency === 'USD')
      .reduce((sum, p) => sum + p.amountMinor, 0);

    const tjsCollectedMinor = postedPaymentsDrilldown
      .filter(p => p.currency === 'TJS')
      .reduce((sum, p) => sum + p.amountMinor, 0);

    const newReservationsVolumeMinor = newReservationsDrilldown.reduce((sum, d) => sum + d.finalPriceMinor, 0);
    const signedDealsVolumeMinor = signedDealsDrilldown.reduce((sum, d) => sum + d.finalPriceMinor, 0);
    const signedAreaM2 = signedDealsDrilldown.reduce((sum, d) => sum + d.areaM2, 0);

    // 6. Breakdown by Manager and Management Direct Sales
    const knownUserIds = new Set(salesReps.map(rep => Number(rep.id)));

    const managerDailyBreakdown = salesReps.map(rep => {
      const mid = Number(rep.id);
      const repNewLeads = newLeadsDrilldown.filter(l => Number(l.managerId) === mid);
      const repCalls = completedCallsDrilldown.filter(c => Number(c.managerId) === mid);
      const repMeetings = completedMeetingsDrilldown.filter(m => Number(m.managerId) === mid);
      const repReservations = newReservationsDrilldown.filter(r => Number(r.managerId) === mid);
      const repSignedDeals = signedDealsDrilldown.filter(s => Number(s.managerId) === mid);
      const repPayments = postedPaymentsDrilldown.filter(p => Number(p.managerId) === mid);
      const repOverdueTasks = overdueTasksDrilldown.filter(t => Number(t.managerId) === mid);

      const repReservationVolumeMinor = repReservations.reduce((sum, r) => sum + r.finalPriceMinor, 0);
      const repSignedVolumeMinor = repSignedDeals.reduce((sum, s) => sum + s.finalPriceMinor, 0);
      const repUsdCashMinor = repPayments.filter(p => p.currency === 'USD').reduce((sum, p) => sum + p.amountMinor, 0);
      const repTjsCashMinor = repPayments.filter(p => p.currency === 'TJS').reduce((sum, p) => sum + p.amountMinor, 0);

      const isManagement = rep.role !== 'SALES_MANAGER';

      return {
        managerId: rep.id,
        name: rep.name,
        role: rep.role,
        isManagement,
        newLeadsCount: repNewLeads.length,
        completedCallsCount: repCalls.length,
        completedMeetingsCount: repMeetings.length,
        newReservationsCount: repReservations.length,
        newReservationsVolumeMinor: repReservationVolumeMinor,
        newReservationsVolumeUsd: Number((repReservationVolumeMinor / 100).toFixed(2)),
        signedDealsCount: repSignedDeals.length,
        signedDealsVolumeMinor: repSignedVolumeMinor,
        signedDealsVolumeUsd: Number((repSignedVolumeMinor / 100).toFixed(2)),
        collectedCashMinor: repUsdCashMinor,
        collectedCashUsd: Number((repUsdCashMinor / 100).toFixed(2)),
        collectedCashTjsMinor: repTjsCashMinor,
        collectedCashTjs: Number((repTjsCashMinor / 100).toFixed(2)),
        overdueTasksCount: repOverdueTasks.length
      };
    });

    // Check for unassigned items (where managerId is null or not in knownUserIds)
    if (isSupervisor && !managerIdFilter) {
      const unassignedLeads = newLeadsDrilldown.filter(l => !l.managerId || !knownUserIds.has(Number(l.managerId)));
      const unassignedCalls = completedCallsDrilldown.filter(c => !c.managerId || !knownUserIds.has(Number(c.managerId)));
      const unassignedMeetings = completedMeetingsDrilldown.filter(m => !m.managerId || !knownUserIds.has(Number(m.managerId)));
      const unassignedReservations = newReservationsDrilldown.filter(r => !r.managerId || !knownUserIds.has(Number(r.managerId)));
      const unassignedSignedDeals = signedDealsDrilldown.filter(s => !s.managerId || !knownUserIds.has(Number(s.managerId)));
      const unassignedPayments = postedPaymentsDrilldown.filter(p => !p.managerId || !knownUserIds.has(Number(p.managerId)));
      const unassignedOverdueTasks = overdueTasksDrilldown.filter(t => !t.managerId || !knownUserIds.has(Number(t.managerId)));

      const hasUnassignedActivity = unassignedLeads.length > 0 || unassignedCalls.length > 0 ||
        unassignedMeetings.length > 0 || unassignedReservations.length > 0 ||
        unassignedSignedDeals.length > 0 || unassignedPayments.length > 0 ||
        unassignedOverdueTasks.length > 0;

      if (hasUnassignedActivity) {
        const unassignedResMinor = unassignedReservations.reduce((sum, r) => sum + r.finalPriceMinor, 0);
        const unassignedSignedMinor = unassignedSignedDeals.reduce((sum, s) => sum + s.finalPriceMinor, 0);
        const unassignedUsdMinor = unassignedPayments.filter(p => p.currency === 'USD').reduce((sum, p) => sum + p.amountMinor, 0);
        const unassignedTjsMinor = unassignedPayments.filter(p => p.currency === 'TJS').reduce((sum, p) => sum + p.amountMinor, 0);

        managerDailyBreakdown.push({
          managerId: 'UNASSIGNED',
          name: 'Прямые сделки (без назначенного менеджера)',
          role: 'DIRECT_SALES',
          isManagement: true,
          isUnassigned: true,
          newLeadsCount: unassignedLeads.length,
          completedCallsCount: unassignedCalls.length,
          completedMeetingsCount: unassignedMeetings.length,
          newReservationsCount: unassignedReservations.length,
          newReservationsVolumeMinor: unassignedResMinor,
          newReservationsVolumeUsd: Number((unassignedResMinor / 100).toFixed(2)),
          signedDealsCount: unassignedSignedDeals.length,
          signedDealsVolumeMinor: unassignedSignedMinor,
          signedDealsVolumeUsd: Number((unassignedSignedMinor / 100).toFixed(2)),
          collectedCashMinor: unassignedUsdMinor,
          collectedCashUsd: Number((unassignedUsdMinor / 100).toFixed(2)),
          collectedCashTjsMinor: unassignedTjsMinor,
          collectedCashTjs: Number((unassignedTjsMinor / 100).toFixed(2)),
          overdueTasksCount: unassignedOverdueTasks.length
        });
      }
    }

    // 7. Server-side safe payload limit and pagination for drilldowns
    const drilldownLimit = query.drilldownLimit ? Math.max(1, Math.min(200, parseInt(query.drilldownLimit, 10))) : 100;
    const drilldownPage = query.drilldownPage ? Math.max(1, parseInt(query.drilldownPage, 10)) : 1;
    const offset = (drilldownPage - 1) * drilldownLimit;

    // Optional single-category drilldown query
    const specificType = query.drilldownType;
    let paginatedDrilldowns;
    let drilldownPagination = null;

    if (specificType) {
      const typeMap = {
        newLeads: newLeadsDrilldown,
        completedCalls: completedCallsDrilldown,
        completedMeetings: completedMeetingsDrilldown,
        newReservations: newReservationsDrilldown,
        signedDeals: signedDealsDrilldown,
        postedPayments: postedPaymentsDrilldown,
        overdueTasks: overdueTasksDrilldown,
        cancelledDeals: cancelledDealsDrilldown
      };

      const targetList = typeMap[specificType] || [];
      const sliced = targetList.slice(offset, offset + drilldownLimit);
      drilldownPagination = {
        type: specificType,
        page: drilldownPage,
        limit: drilldownLimit,
        total: targetList.length,
        totalPages: Math.ceil(targetList.length / drilldownLimit) || 1
      };
      paginatedDrilldowns = {
        [specificType]: sliced
      };
    } else {
      paginatedDrilldowns = {
        newLeads: newLeadsDrilldown.slice(offset, offset + drilldownLimit),
        completedCalls: completedCallsDrilldown.slice(offset, offset + drilldownLimit),
        completedMeetings: completedMeetingsDrilldown.slice(offset, offset + drilldownLimit),
        newReservations: newReservationsDrilldown.slice(offset, offset + drilldownLimit),
        signedDeals: signedDealsDrilldown.slice(offset, offset + drilldownLimit),
        postedPayments: postedPaymentsDrilldown.slice(offset, offset + drilldownLimit),
        overdueTasks: overdueTasksDrilldown.slice(offset, offset + drilldownLimit),
        cancelledDeals: cancelledDealsDrilldown.slice(offset, offset + drilldownLimit)
      };
    }

    return {
      date: targetDate,
      timezone: 'Asia/Dushanbe',
      isSupervisor,
      summary: {
        newLeadsCount: newLeadsDrilldown.length,
        completedCallsCount: completedCallsDrilldown.length,
        completedMeetingsCount: completedMeetingsDrilldown.length,
        totalCompletedInteractions: completedCallsDrilldown.length + completedMeetingsDrilldown.length,
        newReservationsCount: newReservationsDrilldown.length,
        newReservationsVolumeMinor,
        newReservationsVolumeUsd: Number((newReservationsVolumeMinor / 100).toFixed(2)),
        signedDealsCount: signedDealsDrilldown.length,
        signedDealsVolumeMinor,
        signedDealsVolumeUsd: Number((signedDealsVolumeMinor / 100).toFixed(2)),
        signedAreaM2: Number(signedAreaM2.toFixed(2)),
        paymentsCount: postedPaymentsDrilldown.length,
        collectedCashMinor: usdCollectedMinor,
        collectedCashUsd: Number((usdCollectedMinor / 100).toFixed(2)),
        collectedCashTjsMinor: tjsCollectedMinor,
        collectedCashTjs: Number((tjsCollectedMinor / 100).toFixed(2)),
        collectedCashByCurrency: {
          usd: {
            count: postedPaymentsDrilldown.filter(p => p.currency === 'USD').length,
            minor: usdCollectedMinor,
            formatted: Number((usdCollectedMinor / 100).toFixed(2))
          },
          tjs: {
            count: postedPaymentsDrilldown.filter(p => p.currency === 'TJS').length,
            minor: tjsCollectedMinor,
            formatted: Number((tjsCollectedMinor / 100).toFixed(2))
          }
        },
        overdueTasksCount: overdueTasksDrilldown.length,
        cancelledDealsCount: cancelledDealsDrilldown.length,
        cancelledDealsVolumeMinor: cancelledDealsDrilldown.reduce((sum, d) => sum + d.finalPriceMinor, 0)
      },
      managerDailyBreakdown,
      drilldownPagination,
      drilldownMeta: {
        page: drilldownPage,
        limit: drilldownLimit,
        totals: {
          newLeads: newLeadsDrilldown.length,
          completedCalls: completedCallsDrilldown.length,
          completedMeetings: completedMeetingsDrilldown.length,
          newReservations: newReservationsDrilldown.length,
          signedDeals: signedDealsDrilldown.length,
          postedPayments: postedPaymentsDrilldown.length,
          overdueTasks: overdueTasksDrilldown.length,
          cancelledDeals: cancelledDealsDrilldown.length
        },
        isTruncated: {
          newLeads: newLeadsDrilldown.length > offset + drilldownLimit,
          completedCalls: completedCallsDrilldown.length > offset + drilldownLimit,
          completedMeetings: completedMeetingsDrilldown.length > offset + drilldownLimit,
          newReservations: newReservationsDrilldown.length > offset + drilldownLimit,
          signedDeals: signedDealsDrilldown.length > offset + drilldownLimit,
          postedPayments: postedPaymentsDrilldown.length > offset + drilldownLimit,
          overdueTasks: overdueTasksDrilldown.length > offset + drilldownLimit,
          cancelledDeals: cancelledDealsDrilldown.length > offset + drilldownLimit
        }
      },
      drilldowns: paginatedDrilldowns
    };
  }
}
