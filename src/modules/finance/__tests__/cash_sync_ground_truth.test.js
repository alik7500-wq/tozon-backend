import { describe, it, expect, beforeAll } from 'vitest';
import { connectDB, getDB } from '../../../db/connection.js';
import { FinanceRepository } from '../finance.repository.js';

describe('Cash Desk Ground Truth & Sync Verification', () => {
  let db;

  beforeAll(async () => {
    await connectDB();
    db = getDB();
  });

  it('1. Cashflow returns exact Ground Truth balances and consolidated capital', async () => {
    const cashflow = await FinanceRepository.getCashflow();

    expect(cashflow).toBeDefined();
    expect(cashflow.cashDesksSummary).toBeInstanceOf(Array);

    const akmalhon = cashflow.cashDesksSummary.find(d => d.name.includes('Акмалхон'));
    const ilhomjon = cashflow.cashDesksSummary.find(d => d.name.includes('Илхомчон'));

    expect(akmalhon).toBeDefined();
    expect(akmalhon.balanceUsd).toBe(7026.00);
    expect(akmalhon.balanceTjs).toBe(0.00);

    expect(ilhomjon).toBeDefined();
    expect(ilhomjon.balanceUsd).toBe(21575.00);
    expect(ilhomjon.balanceTjs).toBe(0.00);

    // Consolidated capital
    expect(cashflow.summaryByCurrency.USD.netCashflow).toBe(28601.00);
    expect(cashflow.summaryByCurrency.TJS.netCashflow).toBe(0.00);

    // All cash desks have non-negative TJS and exactly 0.00
    cashflow.cashDesksSummary.forEach(desk => {
      expect(desk.balanceTjs).toBeGreaterThanOrEqual(0);
      expect(desk.balanceTjs).toBe(0.00);
    });
  });

  it('2. Boymatov payment ($10 000 USD) is bound to Ilhomjon cash desk', async () => {
    const { data: boymatov } = await db.from('payments').select('*').eq('id', 121).single();

    expect(boymatov).toBeDefined();
    expect(boymatov.amount_minor).toBe(1000000);
    expect(boymatov.currency).toBe('USD');
    expect(boymatov.comment).toContain('Касса компании "Тозон" (Илхомчон)');
  });

  it('3. Erroneous historical transfer set is VOIDED and excluded from active cashflow transactions', async () => {
    const cashflow = await FinanceRepository.getCashflow();
    const voidedPaymentIds = [127, 128, 129];
    const voidedExpenseIds = [54, 87, 88, 93, 94];

    // Verify excluded from active transactions
    const activeVoidedTxs = cashflow.transactions.filter(t => 
      (t.type === 'INCOME' && voidedPaymentIds.includes(t.rawId)) ||
      (t.type === 'EXPENSE' && voidedExpenseIds.includes(t.rawId))
    );
    expect(activeVoidedTxs.length).toBe(0);

    // Verify all 8 records are marked VOIDED in DB
    const { data: pCheck } = await db.from('payments').select('id, status').in('id', voidedPaymentIds);
    pCheck.forEach(p => expect(p.status).toBe('VOIDED'));

    const { data: eCheck } = await db.from('expenses').select('id, status').in('id', voidedExpenseIds);
    eCheck.forEach(e => expect(e.status).toBe('VOIDED'));
  });

  it('4. Multi-currency expense protection: TJS expense debits USD equivalent without negative TJS', async () => {
    const testExpense = await FinanceRepository.addExpense({
      amount: 927,
      currency: 'TJS',
      exchange_rate: 9.27,
      category: 'Прочие расходы',
      recipient: 'Тестовый контрагент',
      description: 'Тестовый расход в TJS',
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
