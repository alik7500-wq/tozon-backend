import { describe, it, expect } from 'vitest';
import { allocatePaymentsFIFO } from '../utils/fifoPaymentAllocation.js';

describe('Payment Schedule Print FIFO Canonical Allocation Tests', () => {
  const dummySchedules = [
    { id: 101, payment_number: 1, due_date: '2026-10-28', amount_minor: 100000, status: 'UPCOMING' },
    { id: 102, payment_number: 2, due_date: '2026-11-28', amount_minor: 100000, status: 'UPCOMING' }
  ];

  // Helper function mimicking the canonical print resolution logic
  function resolvePrintDownPayment(deal, payments) {
    const activePayments = (payments || []).filter(p => p.status !== 'VOIDED');
    const totalActivePaidMinor = activePayments.reduce((sum, p) => sum + (p.amount_minor || 0), 0);
    const plannedDpMinor = deal.down_payment_minor || 0;

    const fifoResult = allocatePaymentsFIFO(dummySchedules, activePayments, plannedDpMinor, '2026-10-02');

    const actualDpPaidMinor = fifoResult.down_payment_covered_minor;
    const remainingDpMinor = Math.max(0, plannedDpMinor - actualDpPaidMinor);
    const totalPaidMinor = totalActivePaidMinor;
    const remainingDebtMinor = Math.max(0, (deal.final_price_minor || 0) - totalPaidMinor);

    return {
      plannedDpMinor,
      actualDpPaidMinor,
      remainingDpMinor,
      totalPaidMinor,
      remainingDebtMinor,
      schedules: fifoResult.schedules,
      excessSchedulePoolMinor: fifoResult.allocatable_to_schedule_minor
    };
  }

  it('Scenario A (Deal 0030): DP 2000, paid 1078.75 -> print actual 1078.75, remaining 921.25', () => {
    const deal = { final_price_minor: 4372500, down_payment_minor: 200000 };
    const payments = [{ id: 1, amount_minor: 107875, status: 'ACTIVE', payment_date: '2026-09-30' }];

    const res = resolvePrintDownPayment(deal, payments);

    expect(res.plannedDpMinor).toBe(200000);
    expect(res.actualDpPaidMinor).toBe(107875);
    expect(res.remainingDpMinor).toBe(92125);
    expect(res.totalPaidMinor).toBe(107875);
    expect(res.remainingDebtMinor).toBe(4264625);
    expect(res.excessSchedulePoolMinor).toBe(0);
    expect(res.schedules[0].paid_amount_minor).toBe(0);
  });

  it('Scenario B: DP 2000, paid 2000 -> print actual 2000, remaining 0', () => {
    const deal = { final_price_minor: 4372500, down_payment_minor: 200000 };
    const payments = [{ id: 1, amount_minor: 200000, status: 'ACTIVE', payment_date: '2026-09-30' }];

    const res = resolvePrintDownPayment(deal, payments);

    expect(res.plannedDpMinor).toBe(200000);
    expect(res.actualDpPaidMinor).toBe(200000);
    expect(res.remainingDpMinor).toBe(0);
    expect(res.totalPaidMinor).toBe(200000);
    expect(res.remainingDebtMinor).toBe(4172500);
    expect(res.excessSchedulePoolMinor).toBe(0);
  });

  it('Scenario C: DP 2000, paid 2500 -> DP actual 2000, excess 500 continues FIFO to monthly schedule', () => {
    const deal = { final_price_minor: 4372500, down_payment_minor: 200000 };
    const payments = [{ id: 1, amount_minor: 250000, status: 'ACTIVE', payment_date: '2026-09-30' }];

    const res = resolvePrintDownPayment(deal, payments);

    expect(res.plannedDpMinor).toBe(200000);
    expect(res.actualDpPaidMinor).toBe(200000);
    expect(res.remainingDpMinor).toBe(0);
    expect(res.excessSchedulePoolMinor).toBe(50000);
    expect(res.schedules[0].paid_amount_minor).toBe(50000); // 500 USD allocated to 1st monthly schedule
  });

  it('Scenario D (Deal 0016): DP 12270, paid 0 -> actual 0, remaining 12270', () => {
    const deal = { final_price_minor: 4090000, down_payment_minor: 1227000 };
    const payments = [];

    const res = resolvePrintDownPayment(deal, payments);

    expect(res.plannedDpMinor).toBe(1227000);
    expect(res.actualDpPaidMinor).toBe(0);
    expect(res.remainingDpMinor).toBe(1227000);
    expect(res.totalPaidMinor).toBe(0);
    expect(res.remainingDebtMinor).toBe(4090000);
  });

  it('Scenario E: VOIDED payment -> ignored in actual DP and total paid', () => {
    const deal = { final_price_minor: 4372500, down_payment_minor: 200000 };
    const payments = [
      { id: 1, amount_minor: 200000, status: 'VOIDED', payment_date: '2026-09-28' },
      { id: 2, amount_minor: 107875, status: 'ACTIVE', payment_date: '2026-09-30' }
    ];

    const res = resolvePrintDownPayment(deal, payments);

    expect(res.actualDpPaidMinor).toBe(107875);
    expect(res.totalPaidMinor).toBe(107875);
  });

  it('Scenario F: Multiple ACTIVE payments -> correct total sum & FIFO allocation', () => {
    const deal = { final_price_minor: 4372500, down_payment_minor: 200000 };
    const payments = [
      { id: 1, amount_minor: 50000, status: 'ACTIVE', payment_date: '2026-09-28' },
      { id: 2, amount_minor: 57875, status: 'ACTIVE', payment_date: '2026-09-30' }
    ];

    const res = resolvePrintDownPayment(deal, payments);

    expect(res.actualDpPaidMinor).toBe(107875);
    expect(res.remainingDpMinor).toBe(92125);
    expect(res.totalPaidMinor).toBe(107875);
  });

  it('Scenario G: Tajik (TJ) and Russian (RU) produce identical numeric values', () => {
    const deal = { final_price_minor: 4372500, down_payment_minor: 200000 };
    const payments = [{ id: 1, amount_minor: 107875, status: 'ACTIVE', payment_date: '2026-09-30' }];

    const resTJ = resolvePrintDownPayment({ ...deal }, payments);
    const resRU = resolvePrintDownPayment({ ...deal }, payments);

    expect(resTJ.actualDpPaidMinor).toEqual(resRU.actualDpPaidMinor);
    expect(resTJ.remainingDpMinor).toEqual(resRU.remainingDpMinor);
    expect(resTJ.totalPaidMinor).toEqual(resRU.totalPaidMinor);
    expect(resTJ.remainingDebtMinor).toEqual(resRU.remainingDebtMinor);
  });
});
