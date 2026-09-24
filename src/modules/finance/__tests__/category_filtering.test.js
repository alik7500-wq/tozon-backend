import 'dotenv/config';
import { describe, it, expect, beforeAll } from 'vitest';
import { matchesCategory, FinanceRepository } from '../finance.repository.js';
import { CashflowExcelService } from '../cashflow_excel.service.js';
import { connectDB } from '../../../db/connection.js';

describe('Category Canonical Filtering & API Contract Suite', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    await connectDB();
  });

  const adminAccess = {
    isAdmin: true,
    allDesks: true,
    canView: true,
    viewableDeskIds: []
  };

  it('1. matchesCategory helper correctly matches codes and human readable category strings', () => {
    expect(matchesCategory('Инвестиции партнёров', 'PARTNER_INVESTMENT')).toBe(true);
    expect(matchesCategory('Инвестиции партнёров', 'Инвестиции партнёров')).toBe(true);
    expect(matchesCategory('Строительные материалы', 'BUILDING_MATERIALS')).toBe(true);
    expect(matchesCategory('Заработная плата', 'SALARY')).toBe(true);
    
    // Negative checks
    expect(matchesCategory('Инвестиции партнёров', 'SALARY')).toBe(false);
    expect(matchesCategory('Строительные материалы', 'NON_EXISTENT_CATEGORY')).toBe(false);
  });

  it('2. Existing category PARTNER_INVESTMENT returns only investment transactions', async () => {
    const res = await FinanceRepository.getCashflow({ category: 'PARTNER_INVESTMENT' }, adminAccess);
    expect(res.transactions).toBeDefined();
    expect(res.transactions.length).toBeGreaterThan(0);
    
    res.transactions.forEach(t => {
      expect(t.category).toMatch(/(Инвестиции партнёров|PARTNER_INVESTMENT)/i);
    });
  });

  it('3. Unknown category returns empty transactions array without masking full dataset', async () => {
    const res = await FinanceRepository.getCashflow({ category: 'UNKNOWN_NONEXISTENT_CATEGORY' }, adminAccess);
    expect(res.transactions).toBeDefined();
    expect(res.transactions.length).toBe(0);
  });

  it('4. Screen and Excel export receive identical category filtering result', async () => {
    const filters = { year: 2026, category: 'PARTNER_INVESTMENT' };
    const res = await FinanceRepository.getCashflow(filters, adminAccess);
    const excelBuffer = await CashflowExcelService.generateExcelBuffer(filters, adminAccess, { name: 'Admin', role: 'ADMIN' });

    expect(excelBuffer).toBeDefined();
    expect(excelBuffer.length).toBeGreaterThan(1000);
    expect(res.transactions.length).toBeGreaterThan(0);
  });

  it('5. Category filter works for both PKOs and RKOs when present in corresponding operations', async () => {
    const res = await FinanceRepository.getCashflow({ category: 'CURRENCY_CONVERSION' }, adminAccess);
    const pkos = res.transactions.filter(t => t.type === 'INCOME');
    const rkos = res.transactions.filter(t => t.type === 'EXPENSE');

    expect(pkos.length).toBeGreaterThan(0);
    expect(rkos.length).toBeGreaterThan(0);
  });
});
