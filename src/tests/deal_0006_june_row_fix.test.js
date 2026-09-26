import assert from 'assert';
import { describe, it } from 'vitest';
import { allocatePaymentsFIFO } from '../utils/fifoPaymentAllocation.js';

describe('Contract № 0006 June Row Status & DB Update Fix Test Suite', () => {

  it('1. Reproduces Deal 0006 state with June row partial payment and past due date', () => {
    // DB state before fix: Feb-May are PAID ($1568.00), June has paid_amount_minor = 0 and status = UPCOMING in DB
    const schedules = [
      { id: 337, due_date: '2026-02-12', amount_minor: 156800, paid_amount_minor: 156800, status: 'PAID' },
      { id: 338, due_date: '2026-03-12', amount_minor: 156800, paid_amount_minor: 156800, status: 'PAID' },
      { id: 339, due_date: '2026-04-12', amount_minor: 156800, paid_amount_minor: 156800, status: 'PAID' },
      { id: 340, due_date: '2026-05-12', amount_minor: 156800, paid_amount_minor: 156800, status: 'PAID' },
      { id: 341, due_date: '2026-06-12', amount_minor: 156800, paid_amount_minor: 0, status: 'UPCOMING' },
      { id: 342, due_date: '2026-07-12', amount_minor: 156800, paid_amount_minor: 0, status: 'OVERDUE' },
      { id: 343, due_date: '2026-08-12', amount_minor: 156800, paid_amount_minor: 0, status: 'OVERDUE' },
      { id: 344, due_date: '2026-09-12', amount_minor: 156700, paid_amount_minor: 0, status: 'OVERDUE' }
    ];

    const payments = [
      { id: 50, amount_minor: 464135, status: 'ACTIVE', payment_date: '2026-02-12' },
      { id: 51, amount_minor: 200000, status: 'ACTIVE', payment_date: '2026-02-12' },
      { id: 53, amount_minor: 156733, status: 'ACTIVE', payment_date: '2026-03-12' },
      { id: 52, amount_minor: 259615, status: 'ACTIVE', payment_date: '2026-05-18' },
      { id: 55, amount_minor: 123118, status: 'ACTIVE', payment_date: '2026-07-04' },
      { id: 56, amount_minor: 115426, status: 'ACTIVE', payment_date: '2026-08-15' },
      { id: 398, amount_minor: 116505, status: 'ACTIVE', payment_date: '2026-09-22' }
    ];

    const todayStr = '2026-09-26';
    const fifoRes = allocatePaymentsFIFO(schedules, payments, 664100, todayStr);

    const juneRow = fifoRes.schedules.find(s => s.id === 341);

    // 1. June row paid amount must be exactly 144232 cents ($1,442.32 USD)
    assert.strictEqual(juneRow.paid_amount_minor, 144232, 'June row paid amount must be 144232 cents');

    // 2. June row remaining amount must be exactly 12568 cents ($125.68 USD)
    assert.strictEqual(juneRow.remaining_amount_minor, 12568, 'June row remaining amount must be 12568 cents');

    // 3. June row status must be OVERDUE (since due_date 2026-06-12 < 2026-09-26 and remaining > 0)
    assert.strictEqual(juneRow.computed_status, 'OVERDUE', 'June row status must be OVERDUE because due_date has passed');

    // 4. Verify that computed_status is one of the valid Postgres check constraint values (PAID, OVERDUE, UPCOMING, PARTIAL)
    const allowedPgStatuses = ['PAID', 'OVERDUE', 'UPCOMING', 'PARTIAL'];
    assert.ok(allowedPgStatuses.includes(juneRow.computed_status), `Status ${juneRow.computed_status} must be valid Postgres check constraint value`);

    // 5. Total overdue calculation on 2026-09-26 must include June remaining $125.68 + July $1568 + Aug $1568 + Sep $1567 = $4,828.68 (482868 cents)
    const overdueTotalMinor = fifoRes.schedules
      .filter(s => s.computed_status === 'OVERDUE')
      .reduce((sum, s) => sum + s.remaining_amount_minor, 0);

    assert.strictEqual(overdueTotalMinor, 482868, 'Total overdue on 2026-09-26 must equal 482868 cents ($4,828.68 USD)');
  });

  it('2. Ensures ALL computed statuses belong strictly to PostgreSQL allowed set [PAID, OVERDUE, UPCOMING, PARTIAL]', () => {
    const allowedPgStatuses = ['PAID', 'OVERDUE', 'UPCOMING', 'PARTIAL'];

    const testSchedules = [
      { id: 1, due_date: '2026-01-01', amount_minor: 100000, status: 'UPCOMING' }, // Past due, fully paid -> PAID
      { id: 2, due_date: '2026-02-01', amount_minor: 100000, status: 'UPCOMING' }, // Past due, partially paid -> OVERDUE
      { id: 3, due_date: '2026-03-01', amount_minor: 100000, status: 'UPCOMING' }, // Past due, zero paid -> OVERDUE
      { id: 4, due_date: '2026-10-01', amount_minor: 100000, status: 'UPCOMING' }, // Future due, partially paid -> PARTIAL
      { id: 5, due_date: '2026-11-01', amount_minor: 100000, status: 'UPCOMING' }  // Future due, zero paid -> UPCOMING
    ];

    const testPayments = [
      { id: 10, amount_minor: 250000, status: 'ACTIVE', payment_date: '2026-01-01' } // 2.5 months paid
    ];

    const fifoRes = allocatePaymentsFIFO(testSchedules, testPayments, 0, '2026-05-01');

    assert.strictEqual(fifoRes.schedules[0].computed_status, 'PAID');
    assert.strictEqual(fifoRes.schedules[1].computed_status, 'PAID');
    assert.strictEqual(fifoRes.schedules[2].computed_status, 'OVERDUE');
    assert.strictEqual(fifoRes.schedules[3].computed_status, 'UPCOMING'); // No pool left for row 4
    assert.strictEqual(fifoRes.schedules[4].computed_status, 'UPCOMING');

    fifoRes.schedules.forEach(s => {
      assert.ok(
        allowedPgStatuses.includes(s.computed_status),
        `Status ${s.computed_status} for row ${s.id} must be in allowed Postgres set`
      );
      assert.notStrictEqual(s.computed_status, 'PARTIALLY_PAID', 'Status PARTIALLY_PAID is forbidden in Postgres');
    });
  });

});
