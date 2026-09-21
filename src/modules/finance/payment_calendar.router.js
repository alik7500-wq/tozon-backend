import express from 'express';
import { getDB } from '../../db/connection.js';
import { protect } from '../../middleware/auth.middleware.js';
import { allocatePaymentsFIFO, getDushanbeCurrentDateStr } from '../../utils/fifoPaymentAllocation.js';

const router = express.Router();
router.use(protect);

router.get('/calendar', async (req, res, next) => {
  try {
    const db = getDB();

    const {
      year,
      month,
      status = 'ALL',
      project_id = 'ALL',
      lead_id = 'ALL',
      overdue_only,
      next_30_days,
      search = ''
    } = req.query;

    const todayStr = getDushanbeCurrentDateStr();
    const currentMonthStr = todayStr.substring(0, 7); // YYYY-MM
    const todayDate = new Date(todayStr);
    const thirtyDaysLaterDate = new Date(todayDate.getTime() + 30 * 24 * 60 * 60 * 1000);
    const thirtyDaysLaterStr = thirtyDaysLaterDate.toISOString().split('T')[0];

    // 1. Fetch active/signed/reserved deals
    let dealsQuery = db.from('deals')
      .select('id, contract_number, currency, status, final_price_minor, down_payment_minor, lead_id, unit_id, leads(full_name, phone), units(unit_number, floors(sections(buildings(projects(id, name)))))')
      .in('status', ['SIGNED', 'RESERVED']);

    const { data: dealsData, error: dealsErr } = await dealsQuery;
    if (dealsErr) throw dealsErr;

    const dealIds = (dealsData || []).map(d => d.id);
    if (dealIds.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          items: [],
          overdueItems: [],
          summary: {
            overdueAmountUsd: 0,
            upcomingAmountUsd: 0,
            receivedAmountUsd: 0,
            advanceAmountUsd: 0,
            totalPaymentsCount: 0,
            overdueRowsCount: 0,
            paidRowsCount: 0,
            partiallyPaidRowsCount: 0,
            upcomingRowsCount: 0,
            currentMonthOverdueUsd: 0,
            currentMonthUpcomingUsd: 0,
            next30DaysUpcomingUsd: 0
          }
        }
      });
    }

    // 2. Fetch all schedules for these deals
    const { data: schedulesData, error: schedErr } = await db.from('deal_payment_schedules')
      .select('*')
      .in('deal_id', dealIds)
      .order('due_date', { ascending: true })
      .order('id', { ascending: true });

    if (schedErr) throw schedErr;

    // 3. Fetch all active/posted payments for these deals
    const { data: paymentsData, error: pmtsErr } = await db.from('payments')
      .select('id, deal_id, amount_minor, payment_date, reference, status')
      .in('deal_id', dealIds);

    if (pmtsErr) throw pmtsErr;

    // Group schedules and payments by deal_id
    const dealsMap = new Map();
    (dealsData || []).forEach(d => dealsMap.set(d.id, d));

    const schedulesByDeal = new Map();
    (schedulesData || []).forEach(s => {
      if (!schedulesByDeal.has(s.deal_id)) schedulesByDeal.set(s.deal_id, []);
      schedulesByDeal.get(s.deal_id).push(s);
    });

    const paymentsByDeal = new Map();
    (paymentsData || []).forEach(p => {
      if (!paymentsByDeal.has(p.deal_id)) paymentsByDeal.set(p.deal_id, []);
      paymentsByDeal.get(p.deal_id).push(p);
    });

    // 4. Run FIFO Allocation per deal
    let allCalendarItems = [];
    let totalAdvanceRemainderMinor = 0;

    for (const [dId, dealScheds] of schedulesByDeal.entries()) {
      const dealObj = dealsMap.get(dId);
      if (!dealObj) continue;

      const dealPmts = paymentsByDeal.get(dId) || [];
      const fifoRes = allocatePaymentsFIFO(dealScheds, dealPmts, dealObj.down_payment_minor, todayStr);
      
      totalAdvanceRemainderMinor += (fifoRes.advance_remainder_minor || 0);

      fifoRes.schedules.forEach(s => {
        const proj = dealObj.units?.floors?.sections?.buildings?.projects || {};
        allCalendarItems.push({
          id: s.id,
          deal_id: dId,
          payment_number: s.payment_number,
          due_date: s.due_date,
          amount_minor: s.planned_amount_minor,
          planned_amount_minor: s.planned_amount_minor,
          fifo_allocated_minor: s.fifo_allocated_minor,
          paid_amount_minor: s.paid_amount_minor,
          remaining_amount_minor: s.remaining_amount_minor,
          stored_status: s.stored_status,
          computed_status: s.computed_status,
          status: s.computed_status,
          status_mismatch: s.status_mismatch,
          contract_number: dealObj.contract_number,
          currency: dealObj.currency || 'USD',
          lead_id: dealObj.lead_id,
          lead_name: dealObj.leads?.full_name,
          lead_phone: dealObj.leads?.phone,
          unit_number: dealObj.units?.unit_number,
          project_id: proj.id,
          project_name: proj.name
        });
      });
    }

    // 5. Separate overdue items list (all OVERDUE items regardless of month filter)
    const allOverdueItems = allCalendarItems.filter(item => item.status === 'OVERDUE');

    // 6. Apply filters to calendar items
    let filteredItems = [...allCalendarItems];

    if (project_id !== 'ALL') {
      filteredItems = filteredItems.filter(i => String(i.project_id) === String(project_id));
    }

    if (lead_id !== 'ALL') {
      filteredItems = filteredItems.filter(i => String(i.lead_id) === String(lead_id));
    }

    if (status !== 'ALL') {
      filteredItems = filteredItems.filter(i => i.status === status);
    }

    if (overdue_only === 'true' || overdue_only === true) {
      filteredItems = filteredItems.filter(i => i.status === 'OVERDUE');
    }

    if (next_30_days === 'true' || next_30_days === true) {
      filteredItems = filteredItems.filter(i => i.due_date >= todayStr && i.due_date <= thirtyDaysLaterStr);
    }

    if (year && year !== 'ALL') {
      filteredItems = filteredItems.filter(i => i.due_date.startsWith(String(year)));
    }

    if (month && month !== 'ALL') {
      const monthStr = String(month).padStart(2, '0');
      filteredItems = filteredItems.filter(i => {
        const parts = i.due_date.split('-');
        return parts[1] === monthStr;
      });
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      filteredItems = filteredItems.filter(i => 
        (i.contract_number && i.contract_number.toLowerCase().includes(q)) ||
        (i.lead_name && i.lead_name.toLowerCase().includes(q)) ||
        (i.project_name && i.project_name.toLowerCase().includes(q))
      );
    }

    // Sort filtered items by due_date ASC, id ASC
    filteredItems.sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id - b.id);

    // 7. Calculate Top Summary Cards for the current filtered selection
    const overdueAmountMinor = filteredItems
      .filter(i => i.status === 'OVERDUE')
      .reduce((sum, i) => sum + i.remaining_amount_minor, 0);

    const upcomingAmountMinor = filteredItems
      .filter(i => i.status === 'UPCOMING')
      .reduce((sum, i) => sum + i.remaining_amount_minor, 0);

    const receivedAmountMinor = filteredItems
      .reduce((sum, i) => sum + i.paid_amount_minor, 0);

    const currentMonthOverdueMinor = filteredItems
      .filter(i => i.status === 'OVERDUE' && i.due_date.startsWith(currentMonthStr))
      .reduce((sum, i) => sum + i.remaining_amount_minor, 0);

    const currentMonthUpcomingMinor = filteredItems
      .filter(i => i.status === 'UPCOMING' && i.due_date.startsWith(currentMonthStr))
      .reduce((sum, i) => sum + i.remaining_amount_minor, 0);

    const next30DaysUpcomingMinor = filteredItems
      .filter(i => i.status === 'UPCOMING' && i.due_date >= todayStr && i.due_date <= thirtyDaysLaterStr)
      .reduce((sum, i) => sum + i.remaining_amount_minor, 0);

    const overdueRowsCount = filteredItems.filter(i => i.status === 'OVERDUE').length;
    const paidRowsCount = filteredItems.filter(i => i.status === 'PAID').length;
    const partiallyPaidRowsCount = filteredItems.filter(i => i.status === 'PARTIALLY_PAID').length;
    const upcomingRowsCount = filteredItems.filter(i => i.status === 'UPCOMING').length;

    res.status(200).json({
      success: true,
      data: {
        items: filteredItems,
        overdueItems: allOverdueItems,
        summary: {
          overdueAmountUsd: overdueAmountMinor / 100,
          upcomingAmountUsd: upcomingAmountMinor / 100,
          receivedAmountUsd: receivedAmountMinor / 100,
          advanceAmountUsd: totalAdvanceRemainderMinor / 100,
          totalPaymentsCount: filteredItems.length,
          overdueRowsCount,
          paidRowsCount,
          partiallyPaidRowsCount,
          upcomingRowsCount,
          currentMonthOverdueUsd: currentMonthOverdueMinor / 100,
          currentMonthUpcomingUsd: currentMonthUpcomingMinor / 100,
          next30DaysUpcomingUsd: next30DaysUpcomingMinor / 100
        }
      }
    });

  } catch (error) {
    next(error);
  }
});

export default router;
