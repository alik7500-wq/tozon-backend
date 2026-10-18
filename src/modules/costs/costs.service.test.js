import { describe, it, expect } from 'vitest';
import { buildCostReport, exclusionReason, usdMinor, splitMinor, canReadCosts, canWriteCosts } from './costs.service.js';
const expense = (patch = {}) => ({ id: 1, amount_minor: 10001, currency: 'USD', expense_date: '2026-10-01', status: 'ACTIVE', operation_type: 'STANDARD', category: 'Materials', ...patch });
const allocation = (patch = {}) => ({ expense_id: 1, mode: 'SHARED', shares: [{ building_id: 3, weight: 200 }, { building_id: 4, weight: 100 }], ...patch });
const report = (patch = {}) => buildCostReport({ buildings: [{ id: 3 }, { id: 4 }], bases: [{ building_id: 3, sellable_area_m2: 200 }, { building_id: 4, sellable_area_m2: 100 }], registry: {}, expenses: [expense()], allocations: [allocation()], advances: [], asOf: '2026-10-18', ...patch });
describe('Paid block costs', () => {
  it('splits cents exactly and calculates using total sellable area', () => {
    const r = report();
    expect(r.blocks.map(b => b.amount_usd_minor)).toEqual([6667, 3334]);
    expect(r.totals.allocated_usd_minor).toBe(10001);
    expect(r.blocks[0].cost_per_m2_usd).toBeCloseTo(0.33335);
  });
  it('preserves a single cent and stable rounding for arbitrary input order', () => {
    expect(splitMinor(1, [{ building_id: 4, weight: 1 }, { building_id: 3, weight: 1 }])).toContainEqual({ building_id: 3, amount: 1 });
  });
  it('does not invent USD conversion for missing FX', () => {
    expect(usdMinor(expense({ currency: 'TJS' }))).toBeNull();
    expect(report({ expenses: [expense({ currency: 'TJS' })] }).rows[0].state).toBe('MISSING_FX');
  });
  it('uses historical rate after TJS edits and snapshot only without rate; USD minor is authoritative', () => {
    expect(usdMinor(expense({ currency: 'TJS', amount_usd: 12.34 }))).toBe(1234);
    expect(usdMinor(expense({ currency: 'TJS', amount_minor: 185400, amount_usd: 100, exchange_rate: 9.27 }))).toBe(20000);
    expect(usdMinor(expense({ currency: 'TJS', amount_minor: 92700, exchange_rate: 9.27 }))).toBe(10000);
    expect(usdMinor(expense({ amount_usd: 1 }))).toBe(10001);
  });
  it.each([{ transfer_id: 'x' }, { operation_type: 'INTERNAL_CASH_TRANSFER' }, { category: 'Конвертация валюты' }, { conversion_id: 'x' }, { status: 'VOIDED' }, { status: 'CANCELLED' }, { voided_at: '2026-10-02' }])('excludes internal/void operations %j even if assigned', patch => {
    const r = report({ expenses: [expense(patch)] }); expect(r.totals.allocated_usd_minor).toBe(0); expect(r.rows[0].state).toBe('AUTO_EXCLUDED');
  });
  it('counts only the main actual expense in an auto-conversion pair', () => {
    expect(exclusionReason(expense({ conversion_id: 'x', conversion_expense_id: 9 }))).toBeNull();
  });
  it('excludes posted advance issues but not settlement payments; never adds stock/advance reports', () => {
    const r = report({ advances: [{ expense_id: 1, kind: 'ADVANCE_ISSUE', status: 'POSTED' }] });
    expect(r.totals.allocated_usd_minor).toBe(0);
    expect(report({ advances: [{ expense_id: 1, kind: 'SETTLEMENT_PAYMENT', status: 'POSTED' }] }).totals.allocated_usd_minor).toBe(10001);
  });
  it('keeps legacy expenses pending and missing area unknown', () => {
    const r = report({ allocations: [], bases: [] }); expect(r.totals.unassigned_count).toBe(1); expect(r.blocks[0].cost_per_m2_usd).toBeNull();
  });
  it('recalculates edited amount and excludes future dates without a second ledger', () => {
    expect(report({ expenses: [expense({ amount_minor: 20000 })] }).totals.allocated_usd_minor).toBe(20000);
    expect(report({ asOf: '2026-09-30' }).rows).toEqual([]);
    expect(report({ expenses: [] }).totals.allocated_usd_minor).toBe(0);
  });
  it('requires a dedicated permission; finance and warehouse access do not expose costs', () => {
    expect(canReadCosts({ role: 'FINANCE_MANAGER', permissions: ['finance.expenses'] })).toBe(false);
    expect(canReadCosts({ permissions: ['finance.costs'] })).toBe(true);
    expect(canWriteCosts({ permissions: ['finance.costs'] })).toBe(false);
    expect(canWriteCosts({ permissions: ['finance.costs', 'finance.costs.write'] })).toBe(true);
  });
});
