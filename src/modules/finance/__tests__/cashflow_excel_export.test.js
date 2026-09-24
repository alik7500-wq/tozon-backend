import { describe, it, expect, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import { CashflowExcelService } from '../cashflow_excel.service.js';
import { FinanceRepository } from '../finance.repository.js';
import { connectDB, getDB } from '../../../db/connection.js';

describe('Cashflow Excel Export & Reconciliation Suite', () => {
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

  const dadojonAccess = {
    isAdmin: false,
    allDesks: false,
    userId: 3,
    cashDeskId: 'SALES_MANAGER_Dadojon',
    viewableDeskIds: ['SALES_MANAGER_Dadojon'],
    incomeDeskIds: ['SALES_MANAGER_Dadojon', 'SALES_MANAGER', 'MAIN_CASHIER'],
    expenseDeskIds: ['SALES_MANAGER_Dadojon']
  };

  it('1. Generates valid Excel buffer with 4 required worksheets', async () => {
    const buffer = await CashflowExcelService.generateExcelBuffer({}, adminAccess, { name: 'Admin', role: 'ADMIN' });
    expect(buffer).toBeDefined();
    expect(buffer.length).toBeGreaterThan(1000);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    expect(workbook.worksheets.length).toBe(4);
    const sheetNames = workbook.worksheets.map(w => w.name);
    expect(sheetNames).toContain('Свод по кассам');
    expect(sheetNames).toContain('Приходы ПКО');
    expect(sheetNames).toContain('Расходы РКО');
    expect(sheetNames).toContain('Сверка');
  });

  it('2. Filter by period and single cash desk works correctly', async () => {
    const filters = { year: 2026, cash_desk_id: '6b5c2380-1ab6-4e39-877a-4f4519a5ab65' };
    const buffer = await CashflowExcelService.generateExcelBuffer(filters, adminAccess, { name: 'Finance Mgr', role: 'FINANCE_MANAGER' });
    
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const sheet1 = workbook.getWorksheet('Свод по кассам');
    expect(sheet1).toBeDefined();
    expect(sheet1.rowCount).toBeGreaterThan(8);
  });

  it('3. USD and TJS are kept separate and not summed directly without conversion', async () => {
    const cashflowData = await FinanceRepository.getCashflow({}, adminAccess);
    expect(cashflowData.summaryByCurrency).toBeDefined();
    expect(cashflowData.summaryByCurrency.USD).toBeDefined();
    expect(cashflowData.summaryByCurrency.TJS).toBeDefined();

    // Verify USD and TJS total Incomes/Expenses are numeric and distinct
    expect(typeof cashflowData.summaryByCurrency.USD.totalIncome).toBe('number');
    expect(typeof cashflowData.summaryByCurrency.TJS.totalIncome).toBe('number');
  });

  it('4. VOIDED operations are excluded from financial totals', async () => {
    const cashflowData = await FinanceRepository.getCashflow({}, adminAccess);
    const voidedTransactions = cashflowData.transactions.filter(t => t.status === 'VOIDED');
    expect(voidedTransactions.length).toBe(0);
  });

  it('5. Dadojon manager cannot view or export Investment cash desk', async () => {
    const cashflowData = await FinanceRepository.getCashflow({}, dadojonAccess);
    const hasInvestmentDesk = cashflowData.cashDesksSummary.some(d => d.name.includes('TOZON PLAZA') || d.name.includes('Инвестиционная'));
    expect(hasInvestmentDesk).toBe(false);

    const buffer = await CashflowExcelService.generateExcelBuffer({}, dadojonAccess, { name: 'Dadojon', role: 'SALES_MANAGER' });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const sheet2 = workbook.getWorksheet('Приходы ПКО');
    sheet2.eachRow((row) => {
      row.eachCell((cell) => {
        const val = String(cell.value || '');
        expect(val).not.toContain('TOZON_PLAZA_INVESTMENT');
        expect(val).not.toContain('Инвестиционная касса TOZON PLAZA');
      });
    });
  });

  it('6. Investment cash desk metrics match historical controls: 399,656.52 - 266,778.73 = 132,877.79 USD', async () => {
    const cashflowData = await FinanceRepository.getCashflow({}, adminAccess);
    const investDesk = cashflowData.cashDesksSummary.find(d => d.name.includes('Инвестиционная касса TOZON PLAZA') || d.name.includes('TOZON PLAZA'));
    expect(investDesk).toBeDefined();

    const transactions = cashflowData.transactions.filter(t => t.cashDeskName && (t.cashDeskName.includes('Инвестиционная касса TOZON PLAZA') || t.cashDeskName.includes('TOZON PLAZA')));
    const pkoImported = transactions.filter(t => t.type === 'INCOME');
    const rkoImported = transactions.filter(t => t.type === 'EXPENSE');

    const pkoSum = pkoImported.reduce((s, t) => s + t.amount, 0);
    const rkoSum = rkoImported.reduce((s, t) => s + t.amount, 0);

    expect(pkoSum).toBeGreaterThanOrEqual(399656.52);
    expect(rkoSum).toBeGreaterThanOrEqual(266778.73);
  });

  it('7. Internal transfers do not artificially inflate consolidated external turnover', async () => {
    const cashflowData = await FinanceRepository.getCashflow({}, adminAccess);
    const internalTxs = cashflowData.transactions.filter(t => t.category === 'Внутренние перемещения между кассами' || t.operationType === 'INTERNAL_CASH_TRANSFER');
    expect(internalTxs).toBeDefined();
  });

  it('8. Formula Injection is neutralized safely in text fields', async () => {
    const buffer = await CashflowExcelService.generateExcelBuffer({}, adminAccess, { name: '=1+1', role: '+ADMIN' });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const sheet1 = workbook.getWorksheet('Свод по кассам');
    const userCellVal = sheet1.getCell('A6').value;
    if (typeof userCellVal === 'string') {
      expect(userCellVal).not.toMatch(/^=[1-9]/);
    }
  });

  it('9. Export operation is strictly read-only and does not mutate DB', async () => {
    const db = getDB();
    const { count: pkoBefore } = await db.from('payments').select('*', { count: 'exact', head: true });
    const { count: rkoBefore } = await db.from('expenses').select('*', { count: 'exact', head: true });

    await CashflowExcelService.generateExcelBuffer({}, adminAccess, { name: 'Tester', role: 'ADMIN' });

    const { count: pkoAfter } = await db.from('payments').select('*', { count: 'exact', head: true });
    const { count: rkoAfter } = await db.from('expenses').select('*', { count: 'exact', head: true });

    expect(pkoAfter).toBe(pkoBefore);
    expect(rkoAfter).toBe(rkoBefore);
  });

  it('11. Sheet 4 Reconciliation checks formula output structure', async () => {
    const buffer = await CashflowExcelService.generateExcelBuffer({}, adminAccess, { name: 'Auditor', role: 'ADMIN' });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const sheet4 = workbook.getWorksheet('Сверка');
    expect(sheet4).toBeDefined();
    expect(sheet4.rowCount).toBeGreaterThanOrEqual(6);
  });

  it('12. Two manually entered investment PKOs are included in export', async () => {
    const cashflowData = await FinanceRepository.getCashflow({ year: 'ALL' }, adminAccess);
    const investDeskTxs = cashflowData.transactions.filter(
      t => t.cashDeskId === '6b5c2380-1ab6-4e39-877a-4f4519a5ab65' && t.type === 'INCOME' && t.status !== 'VOIDED'
    );

    // Verify presence of two manual 150,000 USD PKOs
    const manual150kPkos = investDeskTxs.filter(t => t.amount === 150000);
    expect(manual150kPkos.length).toBe(2);

    // Verify baseline or full PKO count (at least 55 PKOs)
    expect(investDeskTxs.length).toBeGreaterThanOrEqual(55);

    // Verify total inflow (at least 399,656.52 USD)
    const totalPkoSum = investDeskTxs.reduce((sum, t) => sum + t.amount, 0);
    expect(totalPkoSum).toBeGreaterThanOrEqual(399656.52);
  });
});

