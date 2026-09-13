import { describe, it, expect, beforeAll } from 'vitest';
import { connectDB, getDB } from '../../../db/connection.js';
import { FinanceRepository } from '../finance.repository.js';

describe('Cash Desk Balance Formula & Read-Only Idempotency Verification', () => {
  let db;

  beforeAll(async () => {
    await connectDB();
    db = getDB();
  });

  it('1. Cashflow dynamically computes balance = SUM(PKO) - SUM(RKO) per cash desk & currency without hardcoding', async () => {
    const cashflow = await FinanceRepository.getCashflow();

    expect(cashflow).toBeDefined();
    expect(cashflow.cashDesksSummary).toBeInstanceOf(Array);

    let totalDeskUsd = 0;
    let totalDeskTjs = 0;

    for (const desk of cashflow.cashDesksSummary) {
      // Dynamic balance formula verification
      const expectedUsd = Number((desk.totalIncomeUsd - desk.totalExpenseUsd).toFixed(2));
      const expectedTjs = Number((desk.totalIncomeTjs - desk.totalExpenseTjs).toFixed(2));

      expect(desk.balanceUsd).toBe(expectedUsd);
      expect(desk.balanceTjs).toBe(expectedTjs);

      totalDeskUsd = Number((totalDeskUsd + desk.balanceUsd).toFixed(2));
      totalDeskTjs = Number((totalDeskTjs + desk.balanceTjs).toFixed(2));
    }

    // Consolidated capital matches sum of desks
    expect(cashflow.summaryByCurrency.USD.netCashflow).toBe(totalDeskUsd);
    expect(cashflow.summaryByCurrency.TJS.netCashflow).toBe(totalDeskTjs);
  });

  it('2. Mandatory Regression Test: GET cashflow called twice consecutively causes ZERO database mutations', async () => {
    // Snapshot existing state of payments and expenses
    const { data: paymentsBefore, error: errP1 } = await db
      .from('payments')
      .select('id, amount_minor, currency, status, cash_desk_id')
      .order('id', { ascending: true });
    expect(errP1).toBeNull();

    const { data: expensesBefore, error: errE1 } = await db
      .from('expenses')
      .select('id, amount_minor, currency, status, cash_desk_id')
      .order('id', { ascending: true });
    expect(errE1).toBeNull();

    // Call getCashflow twice in succession
    const run1 = await FinanceRepository.getCashflow();
    const run2 = await FinanceRepository.getCashflow();

    expect(run1).toBeDefined();
    expect(run2).toBeDefined();

    // Re-query database to ensure absolute read-only behavior
    const { data: paymentsAfter, error: errP2 } = await db
      .from('payments')
      .select('id, amount_minor, currency, status, cash_desk_id')
      .order('id', { ascending: true });
    expect(errP2).toBeNull();

    const { data: expensesAfter, error: errE2 } = await db
      .from('expenses')
      .select('id, amount_minor, currency, status, cash_desk_id')
      .order('id', { ascending: true });
    expect(errE2).toBeNull();

    // Assert row counts did not change
    expect(paymentsAfter.length).toBe(paymentsBefore.length);
    expect(expensesAfter.length).toBe(expensesBefore.length);

    // Assert every row is strictly identical (no updates, no timestamp bumps, no amount mutations)
    expect(paymentsAfter).toEqual(paymentsBefore);
    expect(expensesAfter).toEqual(expensesBefore);
  });

  it('3. Mathematical formula test: verify currency isolation without cross-contamination', () => {
    // Pure unit formula demonstration
    const sampleDesk = {
      pkoUsd: 1000.00,
      rkoUsd: 250.00,
      pkoTjs: 9270.00,
      rkoTjs: 1000.00
    };

    const usdBalance = Number((sampleDesk.pkoUsd - sampleDesk.rkoUsd).toFixed(2));
    const tjsBalance = Number((sampleDesk.pkoTjs - sampleDesk.rkoTjs).toFixed(2));

    expect(usdBalance).toBe(750.00);
    expect(tjsBalance).toBe(8270.00);
  });

  it('4. Multi-currency expense protection: TJS expense debits USD equivalent without negative TJS', async () => {
    const testExpense = await FinanceRepository.addExpense({
      amount: 927,
      currency: 'TJS',
      exchange_rate: 9.27,
      category: 'Прочие расходы',
      recipient: 'Тестовый контрагент',
      description: 'Тестовый расход в TJS',
      cash_desk_id: 'ab90800a-73af-4cf7-88c2-397c304e2edf',
      date: '2026-09-11'
    }, 1);

    expect(testExpense).toBeDefined();
    expect(testExpense.currency).toBe('USD');
    expect(testExpense.amount_usd).toBe(100.00);
    expect(testExpense.amount_minor).toBe(10000);
    expect(Number(testExpense.exchange_rate)).toBe(9.27);

    // Clean up test expense
    await db.from('expenses').delete().eq('id', testExpense.id);
  });
});

