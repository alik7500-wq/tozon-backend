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

  it('3. Three internal transfers are correctly categorized as internal transfers, not deal sales', async () => {
    const cashflow = await FinanceRepository.getCashflow();
    const transferPaymentIds = [127, 128, 129];
    const transferExpenseIds = [54, 88, 94];

    const transferTxs = cashflow.transactions.filter(t => 
      (t.type === 'INCOME' && transferPaymentIds.includes(t.rawId)) ||
      (t.type === 'EXPENSE' && transferExpenseIds.includes(t.rawId))
    );

    expect(transferTxs.length).toBe(6);

    transferTxs.forEach(t => {
      expect(t.category).toBe('Внутренние перемещения между кассами');
      expect(t.title).toBe('Внутреннее перемещение между кассами');
      expect(t.category).not.toBe('Поступления по сделкам');
    });
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
