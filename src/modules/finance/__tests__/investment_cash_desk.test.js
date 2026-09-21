import { describe, it, expect, beforeAll } from 'vitest';
import { connectDB, getDB } from '../../../db/connection.js';
import { FinanceRepository } from '../finance.repository.js';

describe('Investment Cash Desk TOZON_PLAZA_INVESTMENT Tests', () => {
  let db;
  let investmentDeskId;
  let testPkoId = null;

  const adminAccess = {
    isAdmin: true,
    userId: 1,
    cashDeskId: null,
    viewableDeskIds: [],
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

    const { data: desk } = await db.from('dictionaries')
      .select('id')
      .eq('code', 'TOZON_PLAZA_INVESTMENT')
      .eq('type', 'CASH_DESK')
      .single();
    
    expect(desk).toBeDefined();
    investmentDeskId = desk.id;
  });

  it('1. Cash desk and DDS category exist and are active in dictionaries', async () => {
    const { data: desk } = await db.from('dictionaries')
      .select('*')
      .eq('code', 'TOZON_PLAZA_INVESTMENT')
      .eq('type', 'CASH_DESK')
      .single();

    expect(desk.name).toBe('Инвестиционная касса TOZON PLAZA');
    expect(desk.is_active).toBe(true);

    const { data: category } = await db.from('dictionaries')
      .select('*')
      .eq('code', 'PARTNER_INVESTMENT')
      .eq('type', 'INCOME_CATEGORY')
      .single();

    expect(category.name).toBe('Инвестиции партнёров');
    expect(category.is_active).toBe(true);
  });

  it('2. Initial balance of TOZON_PLAZA_INVESTMENT is 0 USD and 0 TJS', async () => {
    const cashflow = await FinanceRepository.getCashflow({}, adminAccess);
    const invDeskSummary = cashflow.cashDesksSummary.find(d => d.name === 'Инвестиционная касса TOZON PLAZA');
    
    expect(invDeskSummary).toBeDefined();
    expect(invDeskSummary.balanceUsd).toBe(0);
    expect(invDeskSummary.balanceTjs).toBe(0);
  });

  it('3. Create test Partner Investment PKO in TJS with exchange rate', async () => {
    // Record deal sales metrics before test PKO
    const cashflowBefore = await FinanceRepository.getCashflow({}, adminAccess);
    const dealsCountBefore = cashflowBefore.salesSummary.totalDealsCount;
    const contractSumBefore = cashflowBefore.salesSummary.totalContractSumUsd;

    const testPayload = {
      cash_desk_id: investmentDeskId,
      operation_type: 'INVESTMENT',
      payer_name: 'Тестовый Инвестор ООО "Партнёр-Девелопмент"',
      project_id: 3,
      amount: '109000.00',
      currency: 'TJS',
      exchange_rate: '10.90',
      category: 'Инвестиции партнёров',
      purpose: 'Взнос на строительство комплекса TOZON PLAZA',
      basis: 'Инвестиционное соглашение №П-101',
      comment: 'Тестовое внесение инвестиции в TJS',
      date: new Date().toISOString().split('T')[0]
    };

    const createdPko = await FinanceRepository.addIncome(testPayload, 1, adminAccess);
    expect(createdPko).toBeDefined();
    expect(createdPko.id).toBeDefined();
    testPkoId = createdPko.id;

    // Verify DB record properties
    expect(createdPko.deal_id).toBeNull();
    expect(createdPko.schedule_id).toBeNull();
    expect(createdPko.operation_type).toBe('INVESTMENT');
    expect(createdPko.payer_name).toBe('Тестовый Инвестор ООО "Партнёр-Девелопмент"');
    expect(createdPko.amount_usd).toBe(10000);
    expect(createdPko.amount_tjs).toBe(109000);
    expect(Number(createdPko.exchange_rate)).toBe(10.90);

    // Verify cash desk balance update in Cashflow
    const cashflowAfter = await FinanceRepository.getCashflow({}, adminAccess);
    const invDeskSummary = cashflowAfter.cashDesksSummary.find(d => d.name === 'Инвестиционная касса TOZON PLAZA');
    expect(invDeskSummary.balanceTjs).toBe(109000);

    // Verify DDS transaction section and category
    const tx = cashflowAfter.transactions.find(t => t.rawId === testPkoId && t.type === 'INCOME');
    expect(tx).toBeDefined();
    expect(tx.category).toBe('Инвестиции партнёров');
    expect(tx.section).toBe('Финансовая деятельность');
    expect(tx.contract).toBe('Инвестиция партнёра');

    // Verify deal sales summary metrics are NOT altered
    expect(cashflowAfter.salesSummary.totalDealsCount).toBe(dealsCountBefore);
    expect(cashflowAfter.salesSummary.totalContractSumUsd).toBe(contractSumBefore);
  });

  it('4. Voiding/deleting test PKO returns investment cash desk balance to 0', async () => {
    expect(testPkoId).not.toBeNull();

    await FinanceRepository.deleteIncome(testPkoId, 'ADMIN', adminAccess);

    const cashflowAfterVoid = await FinanceRepository.getCashflow({}, adminAccess);
    const invDeskSummary = cashflowAfterVoid.cashDesksSummary.find(d => d.name === 'Инвестиционная касса TOZON PLAZA');
    
    expect(invDeskSummary.balanceUsd).toBe(0);
    expect(invDeskSummary.balanceTjs).toBe(0);

    // Ensure non-investment cash desks remained unchanged
    const mainDesk = cashflowAfterVoid.cashDesksSummary.find(d => d.name.includes('Тозон'));
    expect(mainDesk).toBeDefined();
  });
});
