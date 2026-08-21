import { getDB } from '../../db/connection.js';

export class ReportsRepository {
  /**
   * Analytics 1.0 — Объекты ЖК, Шахматка, Статусы, Блоки и Этажи
   */
  static async getAnalyticsOne(filters = {}) {
    const db = getDB();

    // 1. Fetch units with full hierarchy
    const { data: unitsData, error: uErr } = await db.from('units').select(`
      id, unit_number, rooms, area_m2_x100, price_per_m2_minor, manual_total_price_minor, status,
      floors (
        id, floor_number, name,
        sections (
          id, name,
          buildings (
            id, name,
            projects ( id, name, currency )
          )
        )
      )
    `);

    if (uErr) throw uErr;

    // Filter by project if selected
    let units = unitsData || [];
    if (filters.projectId && filters.projectId !== 'ALL') {
      units = units.filter(u => {
        const proj = u.floors?.sections?.buildings?.projects;
        return proj && (String(proj.id) === String(filters.projectId) || proj.name === filters.projectId);
      });
    }

    // Filter by unit type if selected
    if (filters.unitType && filters.unitType !== 'ALL') {
      if (filters.unitType === 'APARTMENT') {
        units = units.filter(u => u.rooms > 0);
      } else if (filters.unitType === 'COMMERCIAL' || filters.unitType === 'PARKING') {
        units = units.filter(u => u.rooms === 0);
      }
    }

    const totalUnits = units.length;
    let totalArea = 0;
    let totalSum = 0;

    // Status breakdown accumulator
    const statusMap = {
      SOLD: { key: 'SOLD', label: 'Продано', count: 0, area: 0, sum: 0, color: '#ef4444' },
      RESERVED: { key: 'RESERVED', label: 'Бронь', count: 0, area: 0, sum: 0, color: '#eab308' },
      AVAILABLE: { key: 'AVAILABLE', label: 'Свободно', count: 0, area: 0, sum: 0, color: '#10b981' },
      BLOCKED: { key: 'BLOCKED', label: 'Заблокировано / Резерв', count: 0, area: 0, sum: 0, color: '#64748b' },
    };

    // Building/Block accumulator
    const blockMap = {};

    // Floor accumulator
    const floorMap = {};

    units.forEach(u => {
      const area = (u.area_m2_x100 || 0) / 100;
      let unitPrice = 0;
      if (u.manual_total_price_minor) {
        unitPrice = u.manual_total_price_minor / 100;
      } else if (u.price_per_m2_minor) {
        unitPrice = (u.price_per_m2_minor / 100) * area;
      }

      totalArea += area;
      totalSum += unitPrice;

      const st = statusMap[u.status] || statusMap.AVAILABLE;
      st.count += 1;
      st.area += area;
      st.sum += unitPrice;

      // Group by Building
      const bld = u.floors?.sections?.buildings;
      const bldName = bld?.name || 'Основной корпус';
      if (!blockMap[bldName]) {
        blockMap[bldName] = { name: bldName, sold: 0, reserved: 0, available: 0, blocked: 0, total: 0 };
      }
      blockMap[bldName].total += 1;
      if (u.status === 'SOLD') blockMap[bldName].sold += 1;
      else if (u.status === 'RESERVED') blockMap[bldName].reserved += 1;
      else if (u.status === 'BLOCKED') blockMap[bldName].blocked += 1;
      else blockMap[bldName].available += 1;

      // Group by Floor
      const fl = u.floors;
      const flNum = fl?.floor_number ?? 1;
      const flKey = `floor_${flNum}`;
      if (!floorMap[flKey]) {
        floorMap[flKey] = {
          floor: flNum,
          name: fl?.name || `Этаж ${flNum}`,
          sold: 0,
          reserved: 0,
          available: 0,
          blocked: 0,
          total: 0
        };
      }
      floorMap[flKey].total += 1;
      if (u.status === 'SOLD') floorMap[flKey].sold += 1;
      else if (u.status === 'RESERVED') floorMap[flKey].reserved += 1;
      else if (u.status === 'BLOCKED') floorMap[flKey].blocked += 1;
      else floorMap[flKey].available += 1;
    });

    const statusBreakdown = Object.values(statusMap).map(s => {
      const percent = totalUnits > 0 ? Number(((s.count / totalUnits) * 100).toFixed(2)) : 0;
      const priceM2 = s.area > 0 ? Number((s.sum / s.area).toFixed(2)) : 0;
      return {
        ...s,
        area: Number(s.area.toFixed(2)),
        sum: Number(s.sum.toFixed(2)),
        priceM2,
        percent
      };
    });

    const avgPriceM2 = totalArea > 0 ? Number((totalSum / totalArea).toFixed(2)) : 0;

    const blocks = Object.values(blockMap).map(b => {
      const soldPct = b.total > 0 ? Number(((b.sold / b.total) * 100).toFixed(1)) : 0;
      const resvdPct = b.total > 0 ? Number(((b.reserved / b.total) * 100).toFixed(1)) : 0;
      const freePct = b.total > 0 ? Number(((b.available / b.total) * 100).toFixed(1)) : 0;
      const blockedPct = b.total > 0 ? Number(((b.blocked / b.total) * 100).toFixed(1)) : 0;
      return { ...b, soldPct, resvdPct, freePct, blockedPct };
    });

    const floors = Object.values(floorMap)
      .sort((a, b) => a.floor - b.floor)
      .map(f => {
        const soldPct = f.total > 0 ? Number(((f.sold / f.total) * 100).toFixed(1)) : 0;
        const resvdPct = f.total > 0 ? Number(((f.reserved / f.total) * 100).toFixed(1)) : 0;
        const freePct = f.total > 0 ? Number(((f.available / f.total) * 100).toFixed(1)) : 0;
        const blockedPct = f.total > 0 ? Number(((f.blocked / f.total) * 100).toFixed(1)) : 0;
        return { ...f, soldPct, resvdPct, freePct, blockedPct };
      });

    return {
      totalUnits,
      totalArea: Number(totalArea.toFixed(2)),
      totalSum: Number(totalSum.toFixed(2)),
      avgPriceM2,
      statusBreakdown,
      blocks,
      floors
    };
  }

  /**
   * Analytics 2.0 — Продажи и Финансы
   */
  static async getAnalyticsTwo(filters = {}) {
    const db = getDB();
    const currentYear = Number(filters.year) || new Date().getFullYear();

    // 1. Fetch Deals
    const { data: dealsData, error: dErr } = await db.from('deals').select(`
      id, contract_number, status, payment_type, currency, final_price_minor, base_price_minor,
      discount_minor, down_payment_minor, installment_months, deal_date, created_at,
      leads ( id, full_name, phone, source ),
      units (
        id, unit_number, area_m2_x100, price_per_m2_minor,
        floors ( sections ( buildings ( projects ( id, name ) ) ) )
      )
    `);
    if (dErr) throw dErr;

    // Filter deals by project if specified
    let deals = dealsData || [];
    if (filters.projectId && filters.projectId !== 'ALL') {
      deals = deals.filter(d => {
        const p = d.units?.floors?.sections?.buildings?.projects;
        return p && (String(p.id) === String(filters.projectId) || p.name === filters.projectId);
      });
    }

    // 2. Fetch Payments
    const { data: pmtsData, error: pErr } = await db.from('payments').select(`
      id, deal_id, amount_minor, payment_date, method, created_at
    `);
    if (pErr) throw pErr;

    // 3. Fetch Payment Schedules
    const { data: schedsData, error: sErr } = await db.from('deal_payment_schedules').select(`
      id, deal_id, payment_number, due_date, amount_minor, paid_amount_minor, status
    `);
    if (sErr) throw sErr;

    // 4. Fetch Leads for Funnel
    const { data: leadsData } = await db.from('leads').select('id, source, status, created_at, interested_project_id');
    let leads = leadsData || [];
    if (filters.projectId && filters.projectId !== 'ALL') {
      leads = leads.filter(l => String(l.interested_project_id) === String(filters.projectId));
    }

    // Calculations
    const signedDeals = deals.filter(d => d.status === 'SIGNED');
    const reservedDeals = deals.filter(d => d.status === 'RESERVED');
    const installmentDeals = signedDeals.filter(d => d.payment_type === 'INSTALLMENT' || d.payment_type === 'PARTIAL_BARTER');
    const fullPaymentDeals = signedDeals.filter(d => d.payment_type === 'FULL');
    const barterDeals = signedDeals.filter(d => d.payment_type === 'BARTER');

    const totalSignedRevenue = signedDeals.reduce((sum, d) => sum + ((d.final_price_minor || 0) / 100), 0);
    const signedDealIds = new Set(signedDeals.map(d => d.id));

    // Calculate actual payments for signed deals
    const relevantPayments = (pmtsData || []).filter(p => signedDealIds.has(p.deal_id));
    const totalCollectedFromPayments = relevantPayments.reduce((sum, p) => sum + ((p.amount_minor || 0) / 100), 0);

    const relevantSchedules = (schedsData || []).filter(s => signedDealIds.has(s.deal_id));
    const totalCollectedFromSchedules = relevantSchedules.reduce((sum, s) => sum + ((s.paid_amount_minor || 0) / 100), 0);

    const totalCollected = Math.max(totalCollectedFromPayments, totalCollectedFromSchedules);
    const outstandingDebt = Math.max(0, totalSignedRevenue - totalCollected);
    const collectedPercent = totalSignedRevenue > 0 ? Number(((totalCollected / totalSignedRevenue) * 100).toFixed(1)) : 0;

    // Average price/m2 in signed sales
    let soldTotalArea = 0;
    signedDeals.forEach(d => {
      if (d.units?.area_m2_x100) {
        soldTotalArea += d.units.area_m2_x100 / 100;
      }
    });
    const avgPriceM2 = soldTotalArea > 0 ? Number((totalSignedRevenue / soldTotalArea).toFixed(2)) : 0;

    // Funnel Steps
    const funnelSteps = [
      { label: 'Лиды', count: leads.length, color: 'bg-amber-500' },
      { label: 'Бронь', count: reservedDeals.length, color: 'bg-teal-500' },
      { label: 'Договоры (Оформлено)', count: signedDeals.length, color: 'bg-blue-600' },
      { label: 'Рассрочка', count: installmentDeals.length, color: 'bg-emerald-600' },
      { label: 'Полная оплата', count: fullPaymentDeals.length, color: 'bg-indigo-600' },
      { label: 'Бартер / Обмен', count: barterDeals.length, color: 'bg-slate-500' },
    ];

    // Deal Sources aggregation
    const sourceLabels = {
      INSTAGRAM: 'Instagram / Соцсети',
      TELEGRAM: 'Telegram',
      FACEBOOK: 'Facebook',
      PHONE: 'Телефон / Звонок',
      DIRECT: 'Прямой визит / Офис',
      REFERRAL: 'Рекомендация / Знакомые',
      WEBSITE: 'Сайт',
      OTHER: 'Другое',
    };
    const sourceColors = {
      INSTAGRAM: '#3b82f6',
      TELEGRAM: '#06b6d4',
      FACEBOOK: '#6366f1',
      PHONE: '#10b981',
      DIRECT: '#14b8a6',
      REFERRAL: '#f59e0b',
      WEBSITE: '#8b5cf6',
      OTHER: '#94a3b8',
    };

    const sourceCounts = {};
    // Aggregate by deals or all leads
    const itemsWithSource = signedDeals.length > 0 ? signedDeals.map(d => d.leads?.source || 'DIRECT') : leads.map(l => l.source || 'DIRECT');
    itemsWithSource.forEach(src => {
      const cleanSrc = (src || 'OTHER').toUpperCase();
      sourceCounts[cleanSrc] = (sourceCounts[cleanSrc] || 0) + 1;
    });

    const totalSourcesCount = itemsWithSource.length || 1;
    const sources = Object.keys(sourceCounts).map(srcKey => ({
      key: srcKey,
      name: sourceLabels[srcKey] || srcKey,
      count: sourceCounts[srcKey],
      pct: Number(((sourceCounts[srcKey] / totalSourcesCount) * 100).toFixed(1)),
      color: sourceColors[srcKey] || '#64748b'
    })).sort((a, b) => b.count - a.count);

    // Monthly Sales aggregation for currentYear
    const monthNames = [
      'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
      'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
    ];

    const monthlySales = monthNames.map((month, index) => {
      let amount = 0;
      let count = 0;
      signedDeals.forEach(d => {
        const dDate = new Date(d.deal_date || d.created_at);
        if (dDate.getFullYear() === currentYear && dDate.getMonth() === index) {
          amount += (d.final_price_minor || 0) / 100;
          count += 1;
        }
      });
      return {
        month,
        amount: Number(amount.toFixed(2)),
        count
      };
    });

    // Monthly Repayments plan & actual for currentYear
    const monthlyRepayments = monthNames.map((month, index) => {
      let plannedAmount = 0;
      let actualAmount = 0;

      relevantSchedules.forEach(s => {
        if (s.due_date) {
          const sDate = new Date(s.due_date);
          if (sDate.getFullYear() === currentYear && sDate.getMonth() === index) {
            plannedAmount += (s.amount_minor || 0) / 100;
            actualAmount += (s.paid_amount_minor || 0) / 100;
          }
        }
      });

      // Also check payments in that month
      relevantPayments.forEach(p => {
        if (p.payment_date) {
          const pDate = new Date(p.payment_date);
          if (pDate.getFullYear() === currentYear && pDate.getMonth() === index) {
            actualAmount = Math.max(actualAmount, (p.amount_minor || 0) / 100);
          }
        }
      });

      return {
        month,
        amount: Number(plannedAmount.toFixed(2)),
        plannedAmount: Number(plannedAmount.toFixed(2)),
        actualAmount: Number(actualAmount.toFixed(2))
      };
    });

    return {
      totalSignedRevenue: Number(totalSignedRevenue.toFixed(2)),
      signedDealsCount: signedDeals.length,
      totalCollected: Number(totalCollected.toFixed(2)),
      collectedPercent,
      outstandingDebt: Number(outstandingDebt.toFixed(2)),
      avgPriceM2,
      funnelSteps,
      sources,
      monthlySales,
      monthlyRepayments
    };
  }

  /**
   * Analytics 3.0 — Маркетинг и Конверсия Лидов
   */
  static async getAnalyticsThree(filters = {}) {
    const db = getDB();
    const currentYear = Number(filters.year) || new Date().getFullYear();

    const { data: leadsData, error: lErr } = await db.from('leads').select('*');
    if (lErr) throw lErr;

    let leads = leadsData || [];
    if (filters.projectId && filters.projectId !== 'ALL') {
      leads = leads.filter(l => String(l.interested_project_id) === String(filters.projectId));
    }

    const totalLeads = leads.length;
    let activeLeads = 0;
    let wonLeads = 0;
    let lostLeads = 0;

    const stagesMap = {
      NEW: { label: 'Новый / В очереди', count: 0, color: 'bg-slate-400' },
      IN_PROGRESS: { label: 'Консультация / В работе', count: 0, color: 'bg-blue-500' },
      NEGOTIATION: { label: 'Принимают решение / Переговоры', count: 0, color: 'bg-amber-500' },
      WON: { label: 'Успешно (Сделка)', count: 0, color: 'bg-emerald-600' },
      LOST: { label: 'Отказ', count: 0, color: 'bg-rose-500' },
    };

    const sourceLabels = {
      INSTAGRAM: 'Instagram / Соцсети',
      TELEGRAM: 'Telegram',
      FACEBOOK: 'Facebook',
      PHONE: 'Телефон / Звонок',
      DIRECT: 'Прямой визит / Офис',
      REFERRAL: 'Рекомендация / Знакомые',
      WEBSITE: 'Сайт',
      OTHER: 'Другое',
    };
    const sourceColors = {
      INSTAGRAM: '#3b82f6',
      TELEGRAM: '#06b6d4',
      FACEBOOK: '#6366f1',
      PHONE: '#10b981',
      DIRECT: '#14b8a6',
      REFERRAL: '#f59e0b',
      WEBSITE: '#8b5cf6',
      OTHER: '#94a3b8',
    };

    const sourceCounts = {};

    leads.forEach(l => {
      const st = l.status || 'NEW';
      if (stagesMap[st]) {
        stagesMap[st].count += 1;
      }
      if (st === 'WON') wonLeads += 1;
      else if (st === 'LOST') lostLeads += 1;
      else activeLeads += 1;

      const src = (l.source || 'OTHER').toUpperCase();
      sourceCounts[src] = (sourceCounts[src] || 0) + 1;
    });

    const conversionRate = totalLeads > 0 ? Number(((wonLeads / totalLeads) * 100).toFixed(2)) : 0;

    const leadStages = Object.values(stagesMap);

    const leadSources = Object.keys(sourceCounts).map(srcKey => ({
      key: srcKey,
      name: sourceLabels[srcKey] || srcKey,
      count: sourceCounts[srcKey],
      pct: totalLeads > 0 ? Number(((sourceCounts[srcKey] / totalLeads) * 100).toFixed(1)) : 0,
      color: sourceColors[srcKey] || '#64748b'
    })).sort((a, b) => b.count - a.count);

    // Monthly Leads aggregation for currentYear
    const monthNames = [
      'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
      'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
    ];

    const monthlyLeads = monthNames.map((month, index) => {
      let count = 0;
      leads.forEach(l => {
        if (l.created_at) {
          const lDate = new Date(l.created_at);
          if (lDate.getFullYear() === currentYear && lDate.getMonth() === index) {
            count += 1;
          }
        }
      });
      return { month, count };
    });

    return {
      totalLeads,
      activeLeads,
      wonLeads,
      lostLeads,
      conversionRate,
      leadStages,
      leadSources,
      monthlyLeads
    };
  }

  /**
   * Сводные отчеты и KPI Менеджеров
   */
  static async getSummaryReports() {
    const db = getDB();

    // 1. Units summary
    const { data: units } = await db.from('units').select('status');
    const unitsSummary = { total: 0, available: 0, reserved: 0, sold: 0, blocked: 0 };
    (units || []).forEach(u => {
      unitsSummary.total += 1;
      if (u.status === 'AVAILABLE') unitsSummary.available += 1;
      else if (u.status === 'RESERVED') unitsSummary.reserved += 1;
      else if (u.status === 'SOLD') unitsSummary.sold += 1;
      else if (u.status === 'BLOCKED') unitsSummary.blocked += 1;
    });

    // 2. Deals summary
    const { data: deals } = await db.from('deals').select('id, status, final_price_minor, responsible_user_id');
    const signedDeals = (deals || []).filter(d => d.status === 'SIGNED');
    const totalRevenue = signedDeals.reduce((acc, d) => acc + ((d.final_price_minor || 0) / 100), 0);

    // 3. Payments
    const { data: payments } = await db.from('payments').select('amount_minor');
    const totalCollected = (payments || []).reduce((acc, p) => acc + ((p.amount_minor || 0) / 100), 0);
    const outstandingDebt = Math.max(0, totalRevenue - totalCollected);

    // 4. Leads
    const { data: leads } = await db.from('leads').select('id, status, responsible_user_id');
    const totalLeads = (leads || []).length;
    const wonLeads = (leads || []).filter(l => l.status === 'WON').length;
    const conversionRate = totalLeads > 0 ? Number(((wonLeads / totalLeads) * 100).toFixed(1)) : 0;

    // 5. Users / Managers KPI
    const { data: users } = await db.from('users').select('id, name, email, role, is_active');
    const { data: tasks } = await db.from('tasks').select('id, assigned_user_id, status');

    const managersKPI = (users || []).map(u => {
      const userLeads = (leads || []).filter(l => l.responsible_user_id === u.id);
      const userDeals = (signedDeals || []).filter(d => d.responsible_user_id === u.id);
      const userTasks = (tasks || []).filter(t => t.assigned_user_id === u.id && t.status === 'OPEN');
      const salesVolume = userDeals.reduce((acc, d) => acc + ((d.final_price_minor || 0) / 100), 0);
      const userConversion = userLeads.length > 0 ? Number(((userDeals.length / userLeads.length) * 100).toFixed(1)) : 0;

      return {
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        totalLeads: userLeads.length,
        dealsCount: userDeals.length,
        salesVolume: Number(salesVolume.toFixed(2)),
        conversionRate: userConversion,
        openTasksCount: userTasks.length
      };
    });

    return {
      financials: {
        totalRevenue: Number(totalRevenue.toFixed(2)),
        totalCollected: Number(totalCollected.toFixed(2)),
        outstandingDebt: Number(outstandingDebt.toFixed(2)),
        conversionRate,
        signedDealsCount: signedDeals.length,
      },
      units: unitsSummary,
      managersKPI
    };
  }
}
