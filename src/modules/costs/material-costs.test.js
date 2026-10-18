import { describe, it, expect } from 'vitest';
import { buildCostReport } from './costs.service.js';
const usage = (patch = {}) => ({ id: 'u1', building_id: 3, material_kind: 'REBAR', usage_date: '2026-10-01', amount: 100000, currency: 'TJS', exchange_rate: 10, quantity: 20, unit: 'т', status: 'ACTIVE', ...patch });
const expense = (patch = {}) => ({ id: 1, amount_minor: 400000, currency: 'USD', expense_date: '2026-10-02', category: 'Materials', status: 'ACTIVE', ...patch });
const payment = (patch = {}) => ({ id: 'p1', usage_id: 'u1', expense_id: 1, paid_amount: 40000, cash_usd_minor: 400000, ...patch });
const report = (patch = {}) => buildCostReport({ buildings: [{ id: 3 }, { id: 4 }], bases: [{ building_id: 3, sellable_area_m2: 1000 }], registry: {}, expenses: [expense()], allocations: [{ expense_id: 1, mode: 'DIRECT', shares: [{ building_id: 3, weight: 1 }] }], advances: [], asOf: '2026-10-18', materialUsages: [usage()], materialPayments: [payment()], ...patch });
describe('RKO plus unpaid used concrete/rebar', () => {
  it('counts paid 40000 + unpaid 60000 once, on the usage block', () => {
    const r = report(); const b = r.blocks[0];
    expect(b.amount_usd_minor).toBe(1000000); expect(b.paid_cost_usd_minor).toBe(400000); expect(b.unpaid_material_usd_minor).toBe(600000);
    expect(b.ordinary_rko_usd_minor).toBe(0); expect(r.rows[0].state).toBe('MATERIAL_PAYMENT'); expect(b.cost_per_m2_usd).toBe(10);
  });
  it('later full settlement reduces debt without growing cost even at a different FX rate', () => {
    const r = report({ expenses: [expense(), expense({ id: 2, amount_minor: 700000 })], materialPayments: [payment(), payment({ id: 'p2', expense_id: 2, paid_amount: 60000, cash_usd_minor: 700000 })] });
    expect(r.blocks[0].amount_usd_minor).toBe(1000000); expect(r.blocks[0].unpaid_material_usd_minor).toBe(0);
    expect(r.blocks[0].paid_cost_usd_minor).toBe(1000000); // valuation at recognition, not extra cost from settlement FX
  });
  it('allows supplier credit with no RKO and keeps ordinary minor costs', () => {
    const r = report({ materialPayments: [], expenses: [expense({ amount_minor: 10000 })] });
    expect(r.blocks[0].amount_usd_minor).toBe(1010000); expect(r.blocks[0].unpaid_material_usd_minor).toBe(1000000);
  });
  it('recognises partial mixed RKO only for its ordinary residual', () => {
    const r = report({ materialPayments: [payment({ cash_usd_minor: 300000, paid_amount: 30000 })] });
    expect(r.blocks[0].ordinary_rko_usd_minor).toBe(100000); expect(r.blocks[0].amount_usd_minor).toBe(1100000);
  });
  it('does not count a prepayment before the material is used', () => {
    const r = report({ asOf: '2026-10-03', materialUsages: [usage({ usage_date: '2026-10-05' })] });
    expect(r.blocks[0].amount_usd_minor).toBe(0); expect(r.rows[0].state).toBe('MATERIAL_PAYMENT');
  });
  it('reverses debt coverage, not material cost, when the payment is voided', () => {
    const r = report({ expenses: [expense({ status: 'VOIDED' })] });
    expect(r.blocks[0].amount_usd_minor).toBe(1000000); expect(r.blocks[0].unpaid_material_usd_minor).toBe(1000000); expect(r.material_payment_problems).toEqual(['p1']);
  });
  it('does not use future payment to close past debt', () => {
    expect(report({ asOf: '2026-10-01' }).blocks[0].unpaid_material_usd_minor).toBe(1000000);
  });
  it('does not add cancelled usages or unlinked inventory', () => {
    expect(report({ expenses: [], materialPayments: [], materialUsages: [usage({ status: 'CANCELLED' })] }).blocks[0].amount_usd_minor).toBe(0);
    expect(report({ expenses: [], materialUsages: [], materialPayments: [] }).blocks[0].amount_usd_minor).toBe(0);
  });
  it('flags source reduction below linked amounts without duplicating cost', () => {
    const r = report({ expenses: [expense({ amount_minor: 10000 })] });
    expect(r.material_payment_problems).toHaveLength(1); expect(r.blocks[0].amount_usd_minor).toBe(1000000);
  });
  it('supports one RKO split over multiple usages and stable rounding of original-currency debt', () => {
    const r = report({ materialUsages: [usage({ amount: 100000 }), usage({ id: 'u2', building_id: 4, amount: 50000 })], materialPayments: [payment({ paid_amount: 20000, cash_usd_minor: 200000 }), payment({ id: 'p2', usage_id: 'u2', paid_amount: 20000, cash_usd_minor: 200000 })] });
    expect(r.totals.allocated_usd_minor).toBe(1500000); expect(r.blocks[1].unpaid_material_usd_minor).toBe(300000);
  });
});
