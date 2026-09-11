import { describe, it, expect, beforeAll } from 'vitest';
import { connectDB, getDB } from '../../../db/connection.js';
import { FinanceRepository } from '../finance.repository.js';

describe('Dadojon Isolated Cash Desk & Security Gate Verification (Stage B)', () => {
  let db;

  const DADOJON_USER_ID = 3;
  const DADOJON_CASH_DESK_ID = 'fba621e6-4ebe-4459-8623-19f46d864cc6';
  const AKMALHON_CASH_DESK_ID = 'ab90800a-73af-4cf7-88c2-397c304e2edf';

  const dadojonAccess = {
    isAdmin: false,
    cashDeskId: DADOJON_CASH_DESK_ID,
    canView: true,
    canCreateIncome: true,
    canCreateExpense: true,
    canEdit: false,
    canDelete: false,
    canVoid: false
  };

  const adminAccess = {
    isAdmin: true,
    cashDeskId: null,
    canView: true,
    canCreateIncome: true,
    canCreateExpense: true,
    canEdit: true,
    canDelete: true,
    canVoid: true
  };

  beforeAll(async () => {
    await connectDB();
    db = getDB();
  });

  it('1. PKO-64 (payments:110) pinpoint correction integrity', async () => {
    const { data: p110, error } = await db.from('payments').select('*, deals(responsible_user_id)').eq('id', 110).single();
    expect(error).toBeNull();
    expect(p110).toBeDefined();

    // Bound to Akmalhon
    expect(p110.cash_desk_id).toBe(AKMALHON_CASH_DESK_ID);
    // Preserved fields
    expect(p110.reference).toBe('ПКО-64');
    expect(p110.amount_minor).toBe(123517);
    expect(p110.currency).toBe('USD');
    expect(p110.status).toBe('ACTIVE');
    expect(p110.created_by_user_id).toBe(3);
    expect(p110.deals?.responsible_user_id).toBe(3);

    // Audit backup exists
    const { data: backup } = await db.from('finance_audit_backups')
      .select('*')
      .eq('batch_id', 'FIX_PKO64_CASH_DESK_20260911')
      .eq('table_name', 'payments')
      .eq('record_id', '110')
      .maybeSingle();

    expect(backup).toBeDefined();
    expect(backup.full_snapshot).toBeDefined();
    expect(backup.full_snapshot.cash_desk_id).toBe(DADOJON_CASH_DESK_ID);
  });

  it('2. Document counts and Ground Truth cash desk balances', async () => {
    const { count: pkoCount } = await db.from('payments').select('*', { count: 'exact', head: true }).neq('status', 'VOIDED');
    const { count: rkoCount } = await db.from('expenses').select('*', { count: 'exact', head: true }).neq('status', 'VOIDED');

    expect(pkoCount).toBe(71);
    expect(rkoCount).toBe(130);

    const cashflow = await FinanceRepository.getCashflow({}, adminAccess);

    const dadojonDesk = cashflow.cashDesksSummary.find(d => d.name.includes('Дадочон'));
    expect(dadojonDesk).toBeDefined();
    expect(dadojonDesk.balanceUsd).toBe(0.00);
    expect(dadojonDesk.balanceTjs).toBe(0.00);

    const akmalhonDesk = cashflow.cashDesksSummary.find(d => d.name.includes('Акмалхон'));
    expect(akmalhonDesk).toBeDefined();
    expect(akmalhonDesk.balanceUsd).toBe(7026.00);
    expect(akmalhonDesk.balanceTjs).toBe(0.00);

    const ilhomDesk = cashflow.cashDesksSummary.find(d => d.name.includes('Илхомчон'));
    expect(ilhomDesk).toBeDefined();
    expect(ilhomDesk.balanceUsd).toBe(21575.00);
    expect(ilhomDesk.balanceTjs).toBe(0.00);

    expect(cashflow.summaryByCurrency.USD.netCashflow).toBe(28601.00);
    expect(cashflow.summaryByCurrency.TJS.netCashflow).toBe(0.00);
  });

  it('3. Server-side isolation: Dadojon sees ONLY his own cash desk and transactions', async () => {
    const income = await FinanceRepository.getIncome({}, dadojonAccess);
    expect(income.list.length).toBe(0);
    expect(income.totals.USD).toBe(0);
    expect(income.totals.TJS).toBe(0);

    const expenses = await FinanceRepository.getExpenses({}, dadojonAccess);
    expect(expenses.list.length).toBe(0);
    expect(expenses.totals.USD).toBe(0);
    expect(expenses.totals.TJS).toBe(0);

    const cashflow = await FinanceRepository.getCashflow({}, dadojonAccess);
    expect(cashflow.cashDesksSummary.length).toBe(1);
    expect(cashflow.cashDesksSummary[0].name).toContain('Дадочон');
    expect(cashflow.cashDesksSummary[0].balanceUsd).toBe(0.00);
    expect(cashflow.cashDesksSummary[0].balanceTjs).toBe(0.00);
    expect(cashflow.transactions.length).toBe(0);

    // Company-wide sensitive summaries must be hidden/zeroed for manager
    expect(cashflow.salesSummary.totalContractSumUsd).toBe(0);
    expect(cashflow.salesSummary.totalSoldAreaM2).toBe(0);
    expect(cashflow.conversionsSummary.totalConvertedFromUsd).toBe(0);
  });

  it('4. Security gate: Overdraft prevention when creating RKO from zero-balance desk', async () => {
    await expect(
      FinanceRepository.addExpense(
        {
          amount: '100.00',
          currency: 'USD',
          category: 'Хозяйственные расходы',
          description: 'Покупка канцелярии'
        },
        DADOJON_USER_ID,
        dadojonAccess
      )
    ).rejects.toThrow(/Недостаточно средств в кассе менеджера/);
  });

  it('5. Security gate: Strict mutation blocking for non-admin', async () => {
    await expect(
      FinanceRepository.updateIncome(110, { amount: '2000' }, 'SALES_MANAGER', dadojonAccess)
    ).rejects.toThrow(/Редактирование приходных кассовых ордеров запрещено/);

    await expect(
      FinanceRepository.deleteIncome(110, 'SALES_MANAGER', dadojonAccess)
    ).rejects.toThrow(/Удаление приходных кассовых ордеров запрещено/);

    await expect(
      FinanceRepository.updateExpense(1, { amount: '500' }, 'SALES_MANAGER', dadojonAccess)
    ).rejects.toThrow(/Редактирование расходных кассовых ордеров запрещено/);

    await expect(
      FinanceRepository.deleteExpense(1, 'SALES_MANAGER', dadojonAccess)
    ).rejects.toThrow(/Удаление расходных кассовых ордеров запрещено/);
  });
});
