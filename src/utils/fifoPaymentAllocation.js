/**
 * FIFO Payment Allocation Helper for Deal Payment Schedules
 * 
 * Timezone: Asia/Dushanbe (Dynamically computed)
 * 
 * Rules:
 * 1. Down Payment Handling:
 *    down_payment_covered = min(total_active_payments, deal.down_payment_minor)
 *    allocatable_to_schedule = max(0, total_active_payments - down_payment_covered)
 * 
 * 2. Schedule Installment Allocation (FIFO):
 *    planned = amount_minor
 *    computed_paid = min(allocatable_pool, planned)
 *    remaining = max(planned - computed_paid, 0)
 * 
 * 3. Monthly PKO Sum ("Поступило в этом месяце"):
 *    Sum of active PKOs with payment_date matching the schedule item's due_date month (YYYY-MM),
 *    excluding payments that went to cover the down payment.
 * 
 * 4. PKO Breakdown & Bidirectional Allocations:
 *    Tracks exact PKO IDs, dates, and allocated amounts for each schedule line AND
 *    tracks for each PKO: down payment portion, schedule row portions, and unallocated advance remainder.
 */

export function getDushanbeCurrentDateStr() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dushanbe',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

export function allocatePaymentsFIFO(schedules, payments, dealDownPaymentMinor = 0, currentDateStr) {
  const today = currentDateStr || getDushanbeCurrentDateStr();
  const activePayments = (payments || [])
    .filter(p => p.status === 'ACTIVE' || p.status === 'POSTED')
    .sort((a, b) => {
      const dateA = a.payment_date || a.created_at || '';
      const dateB = b.payment_date || b.created_at || '';
      if (dateA !== dateB) return dateA.localeCompare(dateB);
      return a.id - b.id;
    });

  const totalActivePaid = activePayments.reduce((sum, p) => sum + (p.amount_minor || 0), 0);

  const downPayment = dealDownPaymentMinor || 0;
  const downPaymentCovered = Math.min(totalActivePaid, downPayment);

  // 1. Determine portion of each payment allocated to down payment vs schedule pool
  let dpRemainingToCover = downPaymentCovered;
  const pkoPools = activePayments.map(p => {
    const amt = p.amount_minor || 0;
    let usedForDp = 0;
    if (dpRemainingToCover > 0) {
      usedForDp = Math.min(amt, dpRemainingToCover);
      dpRemainingToCover -= usedForDp;
    }
    const schedulePoolAmt = amt - usedForDp;
    const paymentMonth = p.payment_date ? p.payment_date.slice(0, 7) : null;

    return {
      payment: p,
      totalAmount: amt,
      usedForDp,
      schedulePoolAmt,
      remainingForSchedule: schedulePoolAmt,
      paymentMonth,
      scheduleAllocations: []
    };
  });

  const totalSchedulePool = Math.max(0, totalActivePaid - downPaymentCovered);

  // Sort schedules chronologically by due_date
  const sortedSchedules = [...(schedules || [])].sort((a, b) => {
    if (a.due_date !== b.due_date) return a.due_date.localeCompare(b.due_date);
    return a.id - b.id;
  });

  // 2. Allocate FIFO pool across schedule rows & track exact PKO breakdown in both directions
  const enrichedSchedules = sortedSchedules.map(s => {
    const planned = s.amount_minor || 0;
    let needed = planned;
    let paid = 0;
    const allocatedPkos = [];

    for (const pItem of pkoPools) {
      if (needed <= 0) break;
      if (pItem.remainingForSchedule <= 0) continue;

      const take = Math.min(needed, pItem.remainingForSchedule);
      pItem.remainingForSchedule -= take;
      needed -= take;
      paid += take;

      allocatedPkos.push({
        payment_id: pItem.payment.id,
        payment_date: pItem.payment.payment_date,
        reference: pItem.payment.reference,
        method: pItem.payment.method,
        allocated_minor: take
      });

      pItem.scheduleAllocations.push({
        schedule_id: s.id,
        payment_number: s.payment_number,
        due_date: s.due_date,
        allocated_minor: take
      });
    }

    const remaining = Math.max(0, planned - paid);

    // Calculate Monthly PKO Received ("Поступило в этом месяце")
    const scheduleMonth = s.due_date ? s.due_date.slice(0, 7) : '';
    const monthlyPkoMinor = pkoPools
      .filter(pItem => pItem.paymentMonth === scheduleMonth && pItem.schedulePoolAmt > 0)
      .reduce((sum, pItem) => sum + pItem.schedulePoolAmt, 0);

    let computedStatus = 'UPCOMING';
    if (remaining === 0 && planned > 0) {
      computedStatus = 'PAID';
    } else if (remaining > 0 && s.due_date < today) {
      computedStatus = 'OVERDUE';
    } else if (paid > 0 && paid < planned) {
      computedStatus = 'PARTIAL';
    } else {
      computedStatus = 'UPCOMING';
    }

    const storedStatus = s.status;
    const statusMismatch = storedStatus !== computedStatus;

    return {
      ...s,
      paid_amount_minor_db: s.paid_amount_minor || 0,
      planned_amount_minor: planned,
      fifo_allocated_minor: paid,
      paid_amount_minor: paid,
      remaining_amount_minor: remaining,
      monthly_pko_minor: monthlyPkoMinor,
      allocated_pkos: allocatedPkos,
      stored_status: storedStatus,
      computed_status: computedStatus,
      status: computedStatus,
      status_mismatch: statusMismatch
    };
  });

  // Prepare PKO Breakdown list for each PKO
  const pkoAllocations = pkoPools.map(pItem => {
    return {
      payment_id: pItem.payment.id,
      payment_date: pItem.payment.payment_date,
      reference: pItem.payment.reference,
      method: pItem.payment.method,
      currency: pItem.payment.currency || 'USD',
      amount_minor: pItem.totalAmount,
      down_payment_allocated_minor: pItem.usedForDp,
      schedule_allocations: pItem.scheduleAllocations,
      advance_remainder_minor: pItem.remainingForSchedule
    };
  });

  return {
    schedules: enrichedSchedules,
    pko_allocations: pkoAllocations,
    down_payment_covered_minor: downPaymentCovered,
    allocatable_to_schedule_minor: totalSchedulePool,
    advance_remainder_minor: pkoPools.reduce((sum, pItem) => sum + pItem.remainingForSchedule, 0),
    total_active_paid_minor: totalActivePaid
  };
}
