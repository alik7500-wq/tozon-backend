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

/**
 * Returns the ISO week number and year for a given Date
 */
function getIsoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { weekNo, year: d.getUTCFullYear() };
}

/**
 * Generates Monday-Sunday calendar weeks
 */
export function getCalendarWeeksList(year, weeksCount = 8, endBusinessDate = null) {
  const targetDateStr = endBusinessDate || getBusinessDate();
  const [yStr, mStr, dStr] = targetDateStr.split('-');
  const refDate = new Date(Date.UTC(parseInt(yStr, 10), parseInt(mStr, 10) - 1, parseInt(dStr, 10)));

  // Current day of week: Monday=1, ..., Sunday=7
  const currentDayOfWeek = refDate.getUTCDay() || 7;

  // Find Monday of the current week
  const currentMonday = new Date(refDate);
  currentMonday.setUTCDate(refDate.getUTCDate() - (currentDayOfWeek - 1));

  const weeks = [];

  for (let i = weeksCount - 1; i >= 0; i--) {
    const monday = new Date(currentMonday);
    monday.setUTCDate(currentMonday.getUTCDate() - i * 7);

    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);

    const monStr = monday.toISOString().split('T')[0];
    const sunStr = sunday.toISOString().split('T')[0];
    const { weekNo } = getIsoWeek(monday);

    weeks.push({
      weekNumber: weekNo,
      year: monday.getUTCFullYear(),
      startDate: monStr,
      endDate: sunStr,
      label: `W${weekNo} (${monStr.slice(5)} – ${sunStr.slice(5)})`
    });
  }

  return weeks;
}

export class WeeklyDynamicsService {
  /**
   * Helper to verify role and enforce RBAC
   */
  static checkAccess(user) {
    if (!user) {
      throw new AppError('Пользователь не авторизован', 401);
    }
    if (['FINANCE_MANAGER', 'WAREHOUSE_MANAGER'].includes(user.role)) {
      throw new AppError('Доступ к еженедельной динамике продаж запрещен для вашей роли', 403);
    }
  }

  /**
   * Generates Weekly Dynamics of leads, reservations, signed deals, and payments
   * @param {Object} query - { year, weeksCount, fromWeek, toWeek, projectId, buildingId, managerId }
   * @param {Object} user - Authenticated user object
   */
  static async getWeeklyDynamics(query = {}, user) {
    this.checkAccess(user);

    const db = getSecureDB();
    const isSupervisor = ['ADMIN', 'DIRECTOR'].includes(user.role);
    const userId = Number(user.id);

    const todayStr = getBusinessDate();
    const year = query.year ? parseInt(query.year, 10) : parseInt(todayStr.split('-')[0], 10);
    const weeksCount = Math.max(1, Math.min(52, query.weeksCount ? parseInt(query.weeksCount, 10) : 8));

    const projectIdFilter = query.projectId && query.projectId !== 'ALL' ? Number(query.projectId) : null;
    const buildingIdFilter = query.buildingId && query.buildingId !== 'ALL' ? Number(query.buildingId) : null;
    let managerIdFilter = query.managerId && query.managerId !== 'ALL' ? Number(query.managerId) : null;

    if (!isSupervisor) {
      managerIdFilter = userId;
    }

    // 1. Build weeks calendar
    let weeks = getCalendarWeeksList(year, weeksCount, todayStr);

    if (query.fromWeek && query.toWeek) {
      const fromW = parseInt(query.fromWeek, 10);
      const toW = parseInt(query.toWeek, 10);
      weeks = weeks.filter(w => w.weekNumber >= fromW && w.weekNumber <= toW);
    }

    if (weeks.length === 0) {
      weeks = getCalendarWeeksList(year, 8, todayStr);
    }

    const overallStart = weeks[0].startDate;
    const overallEnd = weeks[weeks.length - 1].endDate;

    // 2. Fetch Leads
    let leadsQuery = db
      .from('leads')
      .select(`
        id, full_name, phone, source, status, responsible_user_id,
        interested_project_id, created_at,
        users!responsible_user_id ( id, name )
      `)
      .is('archived_at', null);

    if (!isSupervisor) {
      leadsQuery = leadsQuery.eq('responsible_user_id', userId);
    } else if (managerIdFilter) {
      leadsQuery = leadsQuery.eq('responsible_user_id', managerIdFilter);
    }

    const { data: rawLeads, error: lErr } = await leadsQuery;
    if (lErr) {
      console.error('[WeeklyDynamicsService] Error fetching leads:', lErr.message);
      throw new AppError('Ошибка при получении лидов для еженедельной динамики', 500);
    }
    let allLeads = rawLeads || [];
    if (projectIdFilter) {
      allLeads = allLeads.filter(l => Number(l.interested_project_id) === projectIdFilter);
    }

    // 3. Fetch Deals
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
      console.error('[WeeklyDynamicsService] Error fetching deals:', dErr.message);
      throw new AppError('Ошибка при получении сделок для еженедельной динамики', 500);
    }
    let allDeals = rawDeals || [];

    if (projectIdFilter) {
      allDeals = allDeals.filter(d => Number(d.units?.floors?.sections?.buildings?.project_id) === projectIdFilter);
    }
    if (buildingIdFilter) {
      allDeals = allDeals.filter(d => Number(d.units?.floors?.sections?.buildings?.id) === buildingIdFilter);
    }

    // 4. Fetch Payments (deal-linked, confirmed, non-voided)
    // Rule: "Не смешивать стоимость договоров с фактически полученными платежами"
    // Rule: "Исключать аннулированные платежи (status = VOIDED) и платежи без deal_id"
    let paymentsQuery = db
      .from('payments')
      .select(`
        id, deal_id, amount_minor, payment_date, method, reference,
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
      console.error('[WeeklyDynamicsService] Error fetching payments:', pErr.message);
      throw new AppError('Ошибка при получении платежей для еженедельной динамики', 500);
    }
    let allPayments = rawPayments || [];

    // Filter confirmed payments belonging to real deals
    allPayments = allPayments.filter(p => {
      if (!p.deal_id) return false;
      const status = String(p.status || '').toUpperCase().trim();
      if (['VOIDED', 'REVERSED', 'CANCELLED', 'DRAFT', 'PENDING'].includes(status)) return false;
      const validStatuses = ['ACTIVE', 'POSTED'];
      return validStatuses.includes(status);
    });

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

    // 5. Aggregate metrics for each week
    const weeklyData = weeks.map(week => {
      const { startDate, endDate } = week;

      // Leads in week
      const weekLeads = allLeads.filter(l => {
        const d = getBusinessDate(l.created_at);
        return d >= startDate && d <= endDate;
      }).map(l => ({
        id: l.id,
        fullName: l.full_name || 'Не указано',
        phone: l.phone || '',
        source: l.source,
        status: l.status,
        managerId: l.responsible_user_id,
        managerName: l.users?.name || 'Не назначен',
        createdAt: l.created_at
      }));

      // Reservations in week (status = RESERVED)
      // Rule: "Не смешивать бронирования с подписанными договорами"
      const weekReservations = allDeals.filter(d => {
        if (d.status !== 'RESERVED') return false;
        const resDate = d.created_at ? getBusinessDate(d.created_at) : (d.deal_date ? d.deal_date.slice(0, 10) : null);
        return resDate && resDate >= startDate && resDate <= endDate;
      }).map(d => ({
        id: d.id,
        contractNumber: d.contract_number ? `№${d.contract_number}` : `Бронь #${d.id}`,
        leadId: d.lead_id,
        clientName: d.leads?.full_name || 'Клиент',
        phone: d.leads?.phone || '',
        unitNumber: d.units?.unit_number || '—',
        areaM2: (d.units?.area_m2_x100 || 0) / 100,
        buildingName: d.units?.floors?.sections?.buildings?.name || '—',
        finalPriceMinor: d.final_price_minor || 0,
        finalPriceUsd: Number(((d.final_price_minor || 0) / 100).toFixed(2)),
        currency: d.currency || 'USD',
        reservationExpiresAt: d.reservation_expires_at,
        dealDate: d.deal_date || d.created_at,
        managerId: d.responsible_user_id,
        managerName: d.users?.name || 'Менеджер'
      }));

      // Signed Deals in week (status = SIGNED / CONTRACTED / COMPLETED)
      // Rule: "Не включать отменённые и расторгнутые сделки в действующий факт продаж"
      const weekSignedDeals = allDeals.filter(d => {
        if (!['SIGNED', 'CONTRACTED', 'COMPLETED'].includes(d.status) || d.status === 'CANCELLED') return false;
        const signDate = d.signed_at ? getBusinessDate(d.signed_at) : (d.deal_date ? d.deal_date.slice(0, 10) : null);
        return signDate && signDate >= startDate && signDate <= endDate;
      }).map(d => ({
        id: d.id,
        contractNumber: d.contract_number ? `№${d.contract_number}` : `Договор #${d.id}`,
        leadId: d.lead_id,
        clientName: d.leads?.full_name || 'Клиент',
        phone: d.leads?.phone || '',
        unitNumber: d.units?.unit_number || '—',
        areaM2: (d.units?.area_m2_x100 || 0) / 100,
        buildingName: d.units?.floors?.sections?.buildings?.name || '—',
        finalPriceMinor: d.final_price_minor || 0,
        finalPriceUsd: Number(((d.final_price_minor || 0) / 100).toFixed(2)),
        currency: d.currency || 'USD',
        signedAt: d.signed_at || d.deal_date,
        managerId: d.responsible_user_id,
        managerName: d.users?.name || 'Менеджер'
      }));

      // Cancelled Deals in week (status = CANCELLED)
      const weekCancelledDeals = allDeals.filter(d => {
        if (d.status !== 'CANCELLED') return false;
        const cDate = d.cancelled_at ? getBusinessDate(d.cancelled_at) : (d.updated_at ? getBusinessDate(d.updated_at) : (d.deal_date ? d.deal_date.slice(0, 10) : null));
        return cDate && cDate >= startDate && cDate <= endDate;
      }).map(d => ({
        id: d.id,
        contractNumber: d.contract_number ? `№${d.contract_number}` : `Сделка #${d.id}`,
        leadId: d.lead_id,
        clientName: d.leads?.full_name || 'Клиент',
        phone: d.leads?.phone || '',
        unitNumber: d.units?.unit_number || '—',
        finalPriceMinor: d.final_price_minor || 0,
        finalPriceUsd: Number(((d.final_price_minor || 0) / 100).toFixed(2)),
        currency: d.currency || 'USD',
        cancellationReason: d.cancellation_reason || 'Не указана',
        cancelledAt: d.cancelled_at || d.updated_at,
        managerId: d.responsible_user_id
      }));

      // Payments posted in week
      // Rule: "Не смешивать стоимость договоров с фактически полученными платежами"
      const weekPayments = allPayments.filter(p => {
        const pDate = p.payment_date ? p.payment_date.slice(0, 10) : getBusinessDate(p.created_at);
        return pDate >= startDate && pDate <= endDate;
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
        method: p.method,
        paymentDate: p.payment_date,
        managerId: p.deals?.responsible_user_id
      }));

      // Multi-currency handling: Rule "Не складывать USD и TJS без подтверждённой методики пересчёта"
      const weekPaymentsUsdMinor = weekPayments
        .filter(p => p.currency === 'USD')
        .reduce((sum, p) => sum + p.amountMinor, 0);

      const weekPaymentsTjsMinor = weekPayments
        .filter(p => p.currency === 'TJS')
        .reduce((sum, p) => sum + p.amountMinor, 0);

      const reservationsVolumeMinor = weekReservations.reduce((sum, r) => sum + r.finalPriceMinor, 0);
      const signedVolumeMinor = weekSignedDeals.reduce((sum, s) => sum + s.finalPriceMinor, 0);
      const signedAreaM2 = weekSignedDeals.reduce((sum, s) => sum + s.areaM2, 0);
      const cancelledVolumeMinor = weekCancelledDeals.reduce((sum, c) => sum + c.finalPriceMinor, 0);

      const conversionPercent = weekLeads.length > 0
        ? Number(((weekSignedDeals.length / weekLeads.length) * 100).toFixed(1))
        : 0;

      const rawLimit = query.drilldownLimit || query.weekDrilldownLimit;
      const weekDrilldownLimit = rawLimit ? Math.max(1, Math.min(100, parseInt(rawLimit, 10))) : 50;

      return {
        ...week,
        leadsCount: weekLeads.length,
        reservationsCount: weekReservations.length,
        reservationsVolumeMinor,
        reservationsVolumeUsd: Number((reservationsVolumeMinor / 100).toFixed(2)),
        signedDealsCount: weekSignedDeals.length,
        signedDealsVolumeMinor: signedVolumeMinor,
        signedDealsVolumeUsd: Number((signedVolumeMinor / 100).toFixed(2)),
        signedAreaM2: Number(signedAreaM2.toFixed(2)),
        paymentsCount: weekPayments.length,
        paymentsVolumeMinor: weekPaymentsUsdMinor,
        paymentsVolumeUsd: Number((weekPaymentsUsdMinor / 100).toFixed(2)),
        paymentsVolumeTjsMinor: weekPaymentsTjsMinor,
        paymentsVolumeTjs: Number((weekPaymentsTjsMinor / 100).toFixed(2)),
        cancelledDealsCount: weekCancelledDeals.length,
        cancelledVolumeMinor,
        cancelledVolumeUsd: Number((cancelledVolumeMinor / 100).toFixed(2)),
        conversionPercent,
        drilldowns: {
          leads: weekLeads.slice(0, weekDrilldownLimit),
          reservations: weekReservations.slice(0, weekDrilldownLimit),
          signedDeals: weekSignedDeals.slice(0, weekDrilldownLimit),
          payments: weekPayments.slice(0, weekDrilldownLimit),
          cancelledDeals: weekCancelledDeals.slice(0, weekDrilldownLimit)
        },
        drilldownMeta: {
          limit: weekDrilldownLimit,
          totals: {
            leads: weekLeads.length,
            reservations: weekReservations.length,
            signedDeals: weekSignedDeals.length,
            payments: weekPayments.length,
            cancelledDeals: weekCancelledDeals.length
          },
          isTruncated: {
            leads: weekLeads.length > weekDrilldownLimit,
            reservations: weekReservations.length > weekDrilldownLimit,
            signedDeals: weekSignedDeals.length > weekDrilldownLimit,
            payments: weekPayments.length > weekDrilldownLimit,
            cancelledDeals: weekCancelledDeals.length > weekDrilldownLimit
          }
        }
      };
    });

    // Summary totals across all queried weeks
    const totalLeadsCount = weeklyData.reduce((sum, w) => sum + w.leadsCount, 0);
    const totalReservationsCount = weeklyData.reduce((sum, w) => sum + w.reservationsCount, 0);
    const totalReservationsVolumeMinor = weeklyData.reduce((sum, w) => sum + w.reservationsVolumeMinor, 0);
    const totalSignedDealsCount = weeklyData.reduce((sum, w) => sum + w.signedDealsCount, 0);
    const totalSignedDealsVolumeMinor = weeklyData.reduce((sum, w) => sum + w.signedDealsVolumeMinor, 0);
    const totalSignedAreaM2 = weeklyData.reduce((sum, w) => sum + w.signedAreaM2, 0);
    const totalPaymentsCount = weeklyData.reduce((sum, w) => sum + w.paymentsCount, 0);
    const totalPaymentsVolumeUsdMinor = weeklyData.reduce((sum, w) => sum + w.paymentsVolumeMinor, 0);
    const totalPaymentsVolumeTjsMinor = weeklyData.reduce((sum, w) => sum + w.paymentsVolumeTjsMinor, 0);
    const totalCancelledDealsCount = weeklyData.reduce((sum, w) => sum + w.cancelledDealsCount, 0);
    const totalCancelledVolumeMinor = weeklyData.reduce((sum, w) => sum + w.cancelledVolumeMinor, 0);

    const overallConversionPercent = totalLeadsCount > 0
      ? Number(((totalSignedDealsCount / totalLeadsCount) * 100).toFixed(1))
      : 0;

    return {
      year,
      timezone: 'Asia/Dushanbe',
      isSupervisor,
      periodRange: {
        startDate: overallStart,
        endDate: overallEnd,
        weeksCount: weeklyData.length
      },
      summary: {
        totalLeadsCount,
        totalReservationsCount,
        totalReservationsVolumeMinor,
        totalReservationsVolumeUsd: Number((totalReservationsVolumeMinor / 100).toFixed(2)),
        totalSignedDealsCount,
        totalSignedDealsVolumeMinor,
        totalSignedDealsVolumeUsd: Number((totalSignedDealsVolumeMinor / 100).toFixed(2)),
        totalSignedAreaM2: Number(totalSignedAreaM2.toFixed(2)),
        totalPaymentsCount,
        totalPaymentsVolumeMinor: totalPaymentsVolumeUsdMinor,
        totalPaymentsVolumeUsd: Number((totalPaymentsVolumeUsdMinor / 100).toFixed(2)),
        totalPaymentsVolumeTjsMinor,
        totalPaymentsVolumeTjs: Number((totalPaymentsVolumeTjsMinor / 100).toFixed(2)),
        totalCancelledDealsCount,
        totalCancelledVolumeMinor,
        totalCancelledVolumeUsd: Number((totalCancelledVolumeMinor / 100).toFixed(2)),
        overallConversionPercent
      },
      weeks: weeklyData
    };
  }
}
