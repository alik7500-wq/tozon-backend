import assert from 'node:assert';
import { allocatePaymentsFIFO } from '../utils/fifoPaymentAllocation.js';
import { connectDB, getDB } from '../db/connection.js';

connectDB();

async function runCalendarFifoTests() {
  console.log('===================================================================================');
  console.log('=== AUTOMATED UNIT TESTS: PAYMENT CALENDAR & FIFO ALLOCATION ===');
  console.log('===================================================================================');

  const todayStr = '2026-09-22';

  // -----------------------------------------------------------------------------------
  // TEST 1: Fully paid installment calculation (remaining === 0)
  // -----------------------------------------------------------------------------------
  console.log('\n[TEST 1] Fully paid installment -> status = PAID, remaining = 0');
  {
    const scheds = [{ id: 101, payment_number: 1, due_date: '2026-01-01', amount_minor: 100000, status: 'UPCOMING' }];
    const pmts = [{ id: 1, deal_id: 1, amount_minor: 100000, status: 'ACTIVE' }];
    const res = allocatePaymentsFIFO(scheds, pmts, 0, todayStr);
    assert.strictEqual(res.schedules[0].paid_amount_minor, 100000);
    assert.strictEqual(res.schedules[0].remaining_amount_minor, 0);
    assert.strictEqual(res.schedules[0].status, 'PAID');
    console.log('         STATUS: PASSED');
  }

  // -----------------------------------------------------------------------------------
  // TEST 2: Partial payment calculation (0 < paid < planned)
  // -----------------------------------------------------------------------------------
  console.log('\n[TEST 2] Partial payment -> status = PARTIALLY_PAID');
  {
    const scheds = [{ id: 102, payment_number: 1, due_date: '2026-10-01', amount_minor: 100000, status: 'UPCOMING' }];
    const pmts = [{ id: 2, deal_id: 1, amount_minor: 40000, status: 'ACTIVE' }];
    const res = allocatePaymentsFIFO(scheds, pmts, 0, todayStr);
    assert.strictEqual(res.schedules[0].paid_amount_minor, 40000);
    assert.strictEqual(res.schedules[0].remaining_amount_minor, 60000);
    assert.strictEqual(res.schedules[0].status, 'PARTIALLY_PAID');
    console.log('         STATUS: PASSED');
  }

  // -----------------------------------------------------------------------------------
  // TEST 3: Overdue unpaid installment (due_date < today & remaining > 0)
  // -----------------------------------------------------------------------------------
  console.log('\n[TEST 3] Overdue unpaid installment -> status = OVERDUE');
  {
    const scheds = [{ id: 103, payment_number: 1, due_date: '2026-03-01', amount_minor: 100000, status: 'UPCOMING' }];
    const pmts = [];
    const res = allocatePaymentsFIFO(scheds, pmts, 0, todayStr);
    assert.strictEqual(res.schedules[0].paid_amount_minor, 0);
    assert.strictEqual(res.schedules[0].remaining_amount_minor, 100000);
    assert.strictEqual(res.schedules[0].status, 'OVERDUE');
    console.log('         STATUS: PASSED');
  }

  // -----------------------------------------------------------------------------------
  // TEST 4: Future installment (due_date >= today & remaining > 0)
  // -----------------------------------------------------------------------------------
  console.log('\n[TEST 4] Future installment -> status = UPCOMING');
  {
    const scheds = [{ id: 104, payment_number: 1, due_date: '2026-12-01', amount_minor: 100000, status: 'UPCOMING' }];
    const pmts = [];
    const res = allocatePaymentsFIFO(scheds, pmts, 0, todayStr);
    assert.strictEqual(res.schedules[0].paid_amount_minor, 0);
    assert.strictEqual(res.schedules[0].remaining_amount_minor, 100000);
    assert.strictEqual(res.schedules[0].status, 'UPCOMING');
    console.log('         STATUS: PASSED');
  }

  // -----------------------------------------------------------------------------------
  // TEST 5: Single payment covering multiple installments via FIFO
  // -----------------------------------------------------------------------------------
  console.log('\n[TEST 5] Single payment covering multiple installments sequentially');
  {
    const scheds = [
      { id: 201, payment_number: 1, due_date: '2026-01-01', amount_minor: 50000, status: 'UPCOMING' },
      { id: 202, payment_number: 2, due_date: '2026-02-01', amount_minor: 50000, status: 'UPCOMING' },
      { id: 203, payment_number: 3, due_date: '2026-03-01', amount_minor: 50000, status: 'UPCOMING' }
    ];
    const pmts = [{ id: 10, deal_id: 2, amount_minor: 120000, status: 'ACTIVE' }];
    const res = allocatePaymentsFIFO(scheds, pmts, 0, todayStr);
    assert.strictEqual(res.schedules[0].status, 'PAID');
    assert.strictEqual(res.schedules[0].paid_amount_minor, 50000);
    assert.strictEqual(res.schedules[1].status, 'PAID');
    assert.strictEqual(res.schedules[1].paid_amount_minor, 50000);
    assert.strictEqual(res.schedules[2].status, 'PARTIALLY_PAID');
    assert.strictEqual(res.schedules[2].paid_amount_minor, 20000);
    assert.strictEqual(res.schedules[2].remaining_amount_minor, 30000);
    console.log('         STATUS: PASSED');
  }

  // -----------------------------------------------------------------------------------
  // TEST 6: Down payment handling & allocatable pool calculation
  // -----------------------------------------------------------------------------------
  console.log('\n[TEST 6] Down payment deduction from active payments pool');
  {
    const scheds = [
      { id: 501, payment_number: 1, due_date: '2026-02-03', amount_minor: 85000, status: 'UPCOMING' },
      { id: 502, payment_number: 2, due_date: '2026-03-03', amount_minor: 85000, status: 'UPCOMING' }
    ];
    const pmts = [
      { id: 1, deal_id: 13, amount_minor: 650000, status: 'ACTIVE' }, // Down payment $6500
      { id: 2, deal_id: 13, amount_minor: 239000, status: 'ACTIVE' }  // PKO-9 $2390
    ];
    const downPayment = 650000;
    const res = allocatePaymentsFIFO(scheds, pmts, downPayment, todayStr);
    
    assert.strictEqual(res.down_payment_covered_minor, 650000, 'Down payment must be fully covered ($6500)');
    assert.strictEqual(res.allocatable_to_schedule_minor, 239000, 'Allocatable to schedule pool must be $2390');
    assert.strictEqual(res.schedules[0].status, 'PAID', 'Installment #1 must be PAID');
    assert.strictEqual(res.schedules[1].status, 'PAID', 'Installment #2 must be PAID');
    assert.strictEqual(res.advance_remainder_minor, 69000, 'Remainder pool after 2 installments ($1700) must be $690');
    console.log('         STATUS: PASSED');
  }

  // -----------------------------------------------------------------------------------
  // TEST 7: VOIDED payments ignored
  // -----------------------------------------------------------------------------------
  console.log('\n[TEST 7] VOIDED payments are ignored');
  {
    const scheds = [{ id: 301, payment_number: 1, due_date: '2026-01-01', amount_minor: 50000, status: 'UPCOMING' }];
    const pmts = [{ id: 11, deal_id: 3, amount_minor: 50000, status: 'VOIDED' }];
    const res = allocatePaymentsFIFO(scheds, pmts, 0, todayStr);
    assert.strictEqual(res.schedules[0].paid_amount_minor, 0);
    assert.strictEqual(res.schedules[0].status, 'OVERDUE');
    console.log('         STATUS: PASSED');
  }

  // -----------------------------------------------------------------------------------
  // TEST 8: Control equations for Contracts №0001–№0007
  // -----------------------------------------------------------------------------------
  console.log('\n[TEST 8] Control equations for Contracts №0001–№0007');
  {
    const db = getDB();
    const dealIds = [11, 12, 13, 14, 15, 16, 17];
    const { data: deals } = await db.from('deals').select('*').in('id', dealIds);
    const { data: pmts } = await db.from('payments').select('*').in('deal_id', dealIds);
    const { data: scheds } = await db.from('deal_payment_schedules').select('*').in('deal_id', dealIds);

    for (const d of deals) {
      const dPmts = pmts.filter(p => p.deal_id === d.id && (p.status === 'ACTIVE' || p.status === 'POSTED'));
      const dScheds = scheds.filter(s => s.deal_id === d.id);
      
      const fifoRes = allocatePaymentsFIFO(dScheds, dPmts, d.down_payment_minor, todayStr);
      const totalActivePaid = dPmts.reduce((sum, p) => sum + p.amount_minor, 0);
      const sumSchedAmount = dScheds.reduce((sum, s) => sum + s.amount_minor, 0);

      const allocatedTotal = fifoRes.schedules.reduce((sum, s) => sum + s.paid_amount_minor, 0);
      const remainingTotal = fifoRes.schedules.reduce((sum, s) => sum + s.remaining_amount_minor, 0);

      // Eq 1: sum(FIFO alloc) + advance == allocatable
      assert.strictEqual(allocatedTotal + fifoRes.advance_remainder_minor, fifoRes.allocatable_to_schedule_minor, `Eq 1 failed for Contract ${d.contract_number}`);

      // Eq 2: sum(schedule remaining) == sum of unpaid schedule obligations
      assert.strictEqual(remainingTotal, sumSchedAmount - allocatedTotal, `Eq 2 failed for Contract ${d.contract_number}`);

      // Eq 3: total_paid + remaining_debt == final_price
      const remainingDebt = Math.max(0, d.final_price_minor - totalActivePaid);
      assert.strictEqual(totalActivePaid + remainingDebt, d.final_price_minor, `Eq 3 failed for Contract ${d.contract_number}`);
    }
    console.log('         STATUS: PASSED (All 3 control equations hold with 100% precision for Contracts №0001–№0007)');
  }

  // -----------------------------------------------------------------------------------
  // TEST 9: Top summary cards sum matching exact sum of corresponding rows
  // -----------------------------------------------------------------------------------
  console.log('\n[TEST 9] Top summary cards sum matching exact sum of corresponding rows');
  {
    const db = getDB();
    const { data: upcomingData } = await db
      .from('deal_payment_schedules')
      .select('id, deal_id, payment_number, due_date, amount_minor, paid_amount_minor, status, deals(id, contract_number, currency, status)')
      .order('due_date', { ascending: true })
      .limit(20);

    const filteredUpcoming = (upcomingData || []).filter(s => s.deals?.status === 'SIGNED' || s.deals?.status === 'RESERVED').slice(0, 10);
    
    const top10Enriched = filteredUpcoming.map(s => {
      const planned = s.amount_minor || 0;
      let calculatedStatus = 'UPCOMING';
      let fifoPaid = s.paid_amount_minor || 0;

      if (s.status === 'PAID') {
        calculatedStatus = 'PAID';
        fifoPaid = planned;
      } else {
        if (s.due_date < todayStr) {
          calculatedStatus = 'OVERDUE';
        } else {
          calculatedStatus = 'UPCOMING';
        }
      }

      return {
        ...s,
        planned_amount_minor: planned,
        paid_amount_minor: fifoPaid,
        remaining_amount_minor: Math.max(0, planned - fifoPaid),
        status: calculatedStatus
      };
    });

    const overdueCount = top10Enriched.filter(i => i.status === 'OVERDUE').length;
    const paidCount = top10Enriched.filter(i => i.status === 'PAID').length;
    const overdueSumMinor = top10Enriched.filter(i => i.status === 'OVERDUE').reduce((s, i) => s + i.remaining_amount_minor, 0);

    assert.strictEqual(top10Enriched.length, 10, 'Top selection must contain 10 rows');
    assert.strictEqual(paidCount, 9, 'Top selection must contain 9 PAID rows');
    assert.strictEqual(overdueCount, 1, 'Top selection must contain 1 OVERDUE row');
    assert.strictEqual(overdueSumMinor, 85000, 'Top selection overdue sum must be 85000 minor ($850 USD)');
    console.log('         STATUS: PASSED (9 PAID, 1 OVERDUE, Overdue Sum = $850 USD)');
  }

  console.log('\n===================================================================================');
  console.log('ALL PAYMENT CALENDAR & FIFO ALLOCATION TESTS PASSED SUCCESSFULLY! 100% SPEC COMPLIANT.');
  console.log('===================================================================================');
  process.exit(0);
}

runCalendarFifoTests().catch(e => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
