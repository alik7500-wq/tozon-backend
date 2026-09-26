import assert from 'assert';
import { describe, it } from 'vitest';
import { allocatePaymentsFIFO } from '../utils/fifoPaymentAllocation.js';

describe('Unified Payment Allocation Waterfall & Contract № 0006 Audit Suite', () => {

  it('1. Single PKO covering multiple months waterfall test', () => {
    const schedules = [
      { id: 101, due_date: '2026-02-01', amount_minor: 100000, status: 'UPCOMING' },
      { id: 102, due_date: '2026-03-01', amount_minor: 100000, status: 'UPCOMING' },
      { id: 103, due_date: '2026-04-01', amount_minor: 100000, status: 'UPCOMING' }
    ];
    const payments = [
      { id: 1, amount_minor: 250000, status: 'ACTIVE', payment_date: '2026-02-01' }
    ];

    const res = allocatePaymentsFIFO(schedules, payments, 0, '2026-05-01');
    assert.strictEqual(res.schedules[0].paid_amount_minor, 100000);
    assert.strictEqual(res.schedules[0].status, 'PAID');
    assert.strictEqual(res.schedules[1].paid_amount_minor, 100000);
    assert.strictEqual(res.schedules[1].status, 'PAID');
    assert.strictEqual(res.schedules[2].paid_amount_minor, 50000);
    assert.strictEqual(res.schedules[2].remaining_amount_minor, 50000);
    assert.strictEqual(res.schedules[2].status, 'OVERDUE');
  });

  it('2. Multiple PKOs covering single month waterfall test', () => {
    const schedules = [
      { id: 201, due_date: '2026-02-01', amount_minor: 100000, status: 'UPCOMING' }
    ];
    const payments = [
      { id: 10, amount_minor: 40000, status: 'ACTIVE', payment_date: '2026-02-01' },
      { id: 11, amount_minor: 60000, status: 'ACTIVE', payment_date: '2026-02-05' }
    ];

    const res = allocatePaymentsFIFO(schedules, payments, 0, '2026-05-01');
    assert.strictEqual(res.schedules[0].paid_amount_minor, 100000);
    assert.strictEqual(res.schedules[0].remaining_amount_minor, 0);
    assert.strictEqual(res.schedules[0].status, 'PAID');
  });

  it('3. Backdated payment & cancellation recalculation test', () => {
    const schedules = [
      { id: 301, due_date: '2026-01-01', amount_minor: 100000, status: 'UPCOMING' },
      { id: 302, due_date: '2026-02-01', amount_minor: 100000, status: 'UPCOMING' }
    ];
    let payments = [
      { id: 20, amount_minor: 150000, status: 'ACTIVE', payment_date: '2026-03-01' }
    ];

    let res = allocatePaymentsFIFO(schedules, payments, 0, '2026-05-01');
    assert.strictEqual(res.schedules[0].status, 'PAID');
    assert.strictEqual(res.schedules[1].status, 'OVERDUE');
    assert.strictEqual(res.schedules[1].paid_amount_minor, 50000);

    // Cancel payment
    payments[0].status = 'VOIDED';
    res = allocatePaymentsFIFO(schedules, payments, 0, '2026-05-01');
    assert.strictEqual(res.schedules[0].paid_amount_minor, 0);
    assert.strictEqual(res.schedules[0].status, 'OVERDUE');
    assert.strictEqual(res.schedules[1].paid_amount_minor, 0);
    assert.strictEqual(res.schedules[1].status, 'OVERDUE');
  });

  it('4. Control Equation verification for Contract № 0006 mockup data', () => {
    const schedules = [
      { id: 337, due_date: '2026-02-12', amount_minor: 156800, status: 'UPCOMING' },
      { id: 338, due_date: '2026-03-12', amount_minor: 156800, status: 'UPCOMING' },
      { id: 339, due_date: '2026-04-12', amount_minor: 156800, status: 'UPCOMING' },
      { id: 340, due_date: '2026-05-12', amount_minor: 156800, status: 'UPCOMING' },
      { id: 341, due_date: '2026-06-12', amount_minor: 156800, status: 'UPCOMING' },
      { id: 342, due_date: '2026-07-12', amount_minor: 156800, status: 'UPCOMING' },
      { id: 343, due_date: '2026-08-12', amount_minor: 156800, status: 'UPCOMING' },
      { id: 344, due_date: '2026-09-12', amount_minor: 156700, status: 'UPCOMING' }
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

    const totalActivePaid = payments.reduce((s, p) => s + p.amount_minor, 0);

    // Test under Variant B (Planned down payment = $6,641.00)
    const resB = allocatePaymentsFIFO(schedules, payments, 664100, '2026-09-26');
    const schedAllocatedB = resB.schedules.reduce((s, item) => s + item.paid_amount_minor, 0);
    
    // Control equation: credited_down_payment + credited_schedule + advance_remainder === total_active_payments
    assert.strictEqual(
      resB.down_payment_covered_minor + schedAllocatedB + resB.advance_remainder_minor,
      totalActivePaid,
      'Control equation must hold for Variant B'
    );

    // Test under Variant A (Down payment = initial PKO $4,641.35)
    const resA = allocatePaymentsFIFO(schedules, payments, 464135, '2026-09-26');
    const schedAllocatedA = resA.schedules.reduce((s, item) => s + item.paid_amount_minor, 0);

    assert.strictEqual(
      resA.down_payment_covered_minor + schedAllocatedA + resA.advance_remainder_minor,
      totalActivePaid,
      'Control equation must hold for Variant A'
    );
  });

  it('5. TJS payment conversion USD precision check', () => {
    const schedules = [
      { id: 401, due_date: '2026-02-01', amount_minor: 156800, status: 'UPCOMING' }
    ];
    // TJS payment: 15093.39 TJS @ rate 9.63 = 1567.33 USD (156733 minor)
    const payments = [
      { id: 53, amount_minor: 156733, status: 'ACTIVE', payment_date: '2026-03-12', currency: 'USD' }
    ];

    const res = allocatePaymentsFIFO(schedules, payments, 0, '2026-05-01');
    assert.strictEqual(res.schedules[0].paid_amount_minor, 156733);
    assert.strictEqual(res.schedules[0].remaining_amount_minor, 67); // $0.67 USD remaining
    assert.strictEqual(res.schedules[0].status, 'OVERDUE');
  });
});
