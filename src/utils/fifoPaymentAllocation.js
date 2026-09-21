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
 * 2. Schedule Installment Allocation:
 *    planned = amount_minor
 *    computed_paid = min(allocatable_pool, planned)
 *    remaining = max(planned - computed_paid, 0)
 * 
 * 3. Status Rules:
 *    PAID: remaining === 0
 *    PARTIALLY_PAID: 0 < computed_paid < planned
 *    OVERDUE: remaining > 0 && due_date < currentDate (Asia/Dushanbe)
 *    UPCOMING: remaining > 0 && due_date >= currentDate (Asia/Dushanbe)
 * 
 * 4. Diagnostics:
 *    stored_status = s.status (from DB)
 *    status_mismatch = stored_status !== computed_status
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
  const activePayments = (payments || []).filter(p => p.status === 'ACTIVE' || p.status === 'POSTED');
  const totalActivePaid = activePayments.reduce((sum, p) => sum + (p.amount_minor || 0), 0);

  const downPayment = dealDownPaymentMinor || 0;
  const downPaymentCovered = Math.min(totalActivePaid, downPayment);
  let pool = Math.max(0, totalActivePaid - downPaymentCovered);

  const sortedSchedules = [...(schedules || [])].sort((a, b) => {
    if (a.due_date !== b.due_date) return a.due_date.localeCompare(b.due_date);
    return a.id - b.id;
  });

  const enrichedSchedules = sortedSchedules.map(s => {
    const planned = s.amount_minor || 0;
    let allocated = 0;
    if (pool >= planned) {
      allocated = planned;
      pool -= planned;
    } else {
      allocated = pool;
      pool = 0;
    }

    const paid = Math.min(allocated, planned);
    const remaining = Math.max(0, planned - paid);

    let computedStatus = 'UPCOMING';
    if (remaining === 0 && planned > 0) {
      computedStatus = 'PAID';
    } else if (paid > 0 && paid < planned) {
      computedStatus = 'PARTIALLY_PAID';
    } else if (remaining > 0 && s.due_date < today) {
      computedStatus = 'OVERDUE';
    } else {
      computedStatus = 'UPCOMING';
    }

    const storedStatus = s.status;
    const statusMismatch = storedStatus !== computedStatus;

    return {
      ...s,
      planned_amount_minor: planned,
      fifo_allocated_minor: allocated,
      paid_amount_minor: paid,
      remaining_amount_minor: remaining,
      stored_status: storedStatus,
      computed_status: computedStatus,
      status: computedStatus,
      status_mismatch: statusMismatch
    };
  });

  return {
    schedules: enrichedSchedules,
    down_payment_covered_minor: downPaymentCovered,
    allocatable_to_schedule_minor: Math.max(0, totalActivePaid - downPaymentCovered),
    advance_remainder_minor: pool, // any leftover pool after all schedules
    total_active_paid_minor: totalActivePaid
  };
}
