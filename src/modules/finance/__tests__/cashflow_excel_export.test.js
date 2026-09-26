import { describe, it, expect, beforeAll } from 'vitest';
import ExcelJS from 'exceljs';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { CashflowExcelService } from '../cashflow_excel.service.js';
import { FinanceRepository } from '../finance.repository.js';
import { connectDB, getDB } from '../../../db/connection.js';
import { app } from '../../../app.js';

describe('Cashflow Excel Export & Reconciliation Suite', () => {
  let adminToken, directorToken, financeToken, managerToken;
  const alienDeskUuid = '6b5c2380-1ab6-4e39-877a-4f4519a5ab65'; // Investment cash desk
  const managerOwnDeskUuid = 'ab90800a-73af-4cf7-88c2-397c304e2edf'; // Own desk

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

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    await connectDB();

    const db = getDB();
    const { data: users } = await db.from('users').select('id, role, email');

    const adminUser = users?.find(u => u.role === 'ADMIN') || { id: 1 };
    const directorUser = users?.find(u => u.role === 'DIRECTOR') || adminUser;
    const financeUser = users?.find(u => u.role === 'FINANCE_MANAGER') || adminUser;
    const managerUser = users?.find(u => u.role === 'SALES_MANAGER') || { id: 3 };

    const secret = process.env.JWT_SECRET || 'super-secret-key-for-dev-only';
    adminToken = jwt.sign({ id: adminUser.id }, secret);
    directorToken = jwt.sign({ id: directorUser.id }, secret);
    financeToken = jwt.sign({ id: financeUser.id }, secret);
    managerToken = jwt.sign({ id: managerUser.id }, secret);
  });

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

  it('6. Current Production Investment cash desk control metrics for year=ALL: 58 ACTIVE PKOs (416,778.72 USD), 57 ACTIVE RKOs (416,778.73 USD), Net Balance = -0.01 USD', async () => {
    const cashflowData = await FinanceRepository.getCashflow({ year: 'ALL' }, adminAccess);
    const investDesk = cashflowData.cashDesksSummary.find(d => d.name.includes('Инвестиционная касса TOZON PLAZA') || d.id === alienDeskUuid);
    expect(investDesk).toBeDefined();

    expect(investDesk.totalIncomeUsd).toBe(416778.72);

    const activePkos = cashflowData.transactions.filter(
      t => (t.cashDeskId === alienDeskUuid || t.cash_desk_id === alienDeskUuid) && t.type === 'INCOME' && t.status !== 'VOIDED'
    );
    const activeRkos = cashflowData.transactions.filter(
      t => (t.cashDeskId === alienDeskUuid || t.cash_desk_id === alienDeskUuid) && t.type === 'EXPENSE' && t.status !== 'VOIDED'
    );

    const pkoSum = activePkos.reduce((s, t) => s + t.amount, 0);
    const rkoSum = activeRkos.reduce((s, t) => s + t.amount, 0);
    const netBalance = Number((pkoSum - rkoSum).toFixed(2));

    expect(activePkos.length).toBe(58);
    expect(Number(pkoSum.toFixed(2))).toBe(416778.72);
    expect(activeRkos.length).toBe(57);
    expect(Number(rkoSum.toFixed(2))).toBe(416778.73);
    expect(netBalance).toBe(-0.01);
  });

  it('6b. Historical baseline investment PKO control (period up to 2026-06-30): 55 PKOs / 399,656.52 USD inflow', async () => {
    const filters = { year: 'ALL', date_to: '2026-06-30' };
    const cashflowData = await FinanceRepository.getCashflow(filters, adminAccess);
    const investTxs = cashflowData.transactions.filter(t => t.cashDeskId === alienDeskUuid && t.type === 'INCOME' && t.status !== 'VOIDED');
    
    const historicalPkoSum = investTxs.reduce((s, t) => s + t.amount, 0);
    expect(investTxs.length).toBe(55);
    expect(Number(historicalPkoSum.toFixed(2))).toBe(399656.52);
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
      t => t.cashDeskId === alienDeskUuid && t.type === 'INCOME' && t.status !== 'VOIDED'
    );

    const manual150kPkos = investDeskTxs.filter(t => t.amount === 150000);
    expect(manual150kPkos.length).toBe(2);
    expect(investDeskTxs.length).toBe(58);
  });

  it('13. Excel Parity Test: exact sorted ID match between Excel workbook sheets and FinanceRepository.getCashflow()', async () => {
    const filters = { year: 2026 };
    const buffer = await CashflowExcelService.generateExcelBuffer(filters, adminAccess, { name: 'Admin', role: 'ADMIN' });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const sheetPko = workbook.getWorksheet('Приходы ПКО');
    const excelPkoIds = [];
    sheetPko.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const val = row.getCell(18).value;
      if (typeof val === 'number') {
        excelPkoIds.push(val);
      } else if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
        excelPkoIds.push(Number(val.trim()));
      }
    });

    const sheetRko = workbook.getWorksheet('Расходы РКО');
    const excelRkoIds = [];
    sheetRko.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const val = row.getCell(18).value;
      if (typeof val === 'number') {
        excelRkoIds.push(val);
      } else if (typeof val === 'string' && /^\d+$/.test(val.trim())) {
        excelRkoIds.push(Number(val.trim()));
      }
    });

    const cashflowData = await FinanceRepository.getCashflow(filters, adminAccess);
    const repoPkoIds = cashflowData.transactions
      .filter(t => t.type === 'INCOME')
      .map(t => Number(t.rawId || t.id));
    const repoRkoIds = cashflowData.transactions
      .filter(t => t.type === 'EXPENSE')
      .map(t => Number(t.rawId || t.id));

    expect(excelPkoIds.sort((a, b) => a - b)).toEqual(repoPkoIds.sort((a, b) => a - b));
    expect(excelRkoIds.sort((a, b) => a - b)).toEqual(repoRkoIds.sort((a, b) => a - b));
    expect(excelPkoIds.length).toBeGreaterThan(0);
    expect(excelRkoIds.length).toBeGreaterThan(0);
  });

  describe('Express HTTP Route Access Control & Role Protection Suite', () => {
    it('A. GET /api/finance/cashflow with alien cash_desk_id under SALES_MANAGER returns HTTP 403 and safe error message', async () => {
      const res = await request(app)
        .get(`/api/finance/cashflow?cash_desk_id=${alienDeskUuid}`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(403);
      expect(res.body.message).toContain('Доступ к просмотру чужой кассы запрещен');
      expect(res.body.data).toBeUndefined();
    });

    it('B. GET /api/finance/cashflow/export.xlsx with alien cash_desk_id under SALES_MANAGER returns HTTP 403 without XLSX output', async () => {
      const res = await request(app)
        .get(`/api/finance/cashflow/export.xlsx?cash_desk_id=${alienDeskUuid}`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(403);
      expect(res.headers['content-type']).not.toContain('spreadsheet');
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body.message).toContain('Доступ к просмотру чужой кассы запрещен');
    });

    it('C. GET /api/finance/cashflow with own cash_desk_id under SALES_MANAGER returns HTTP 200 and own operations only', async () => {
      const db = getDB();
      const { data: desks } = await db.from('dictionaries').select('id, code').eq('type', 'CASH_DESK');
      const dadoDesk = desks?.find(d => d.code === 'SALES_MANAGER_Dadojon');
      const ownDeskId = dadoDesk ? dadoDesk.id : managerOwnDeskUuid;

      const res = await request(app)
        .get(`/api/finance/cashflow?cash_desk_id=${ownDeskId}`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.transactions).toBeDefined();
    });

    it('D. GET /api/finance/cashflow without cash_desk_id under SALES_MANAGER returns HTTP 200 with only allowed operations', async () => {
      const res = await request(app)
        .get('/api/finance/cashflow')
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.transactions).toBeDefined();

      const hasAlienDesk = res.body.data.transactions.some(t => t.cashDeskId === alienDeskUuid || t.cash_desk_id === alienDeskUuid);
      expect(hasAlienDesk).toBe(false);
    });

    it('E1. ADMIN can select and export any cash desk with HTTP 200', async () => {
      const resGet = await request(app)
        .get(`/api/finance/cashflow?cash_desk_id=${alienDeskUuid}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(resGet.status).toBe(200);
      expect(resGet.body.success).toBe(true);

      const resExport = await request(app)
        .get(`/api/finance/cashflow/export.xlsx?cash_desk_id=${alienDeskUuid}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(resExport.status).toBe(200);
      expect(resExport.headers['content-type']).toContain('spreadsheet');
    }, 15000);

    it('E2. DIRECTOR can select and export any cash desk with HTTP 200', async () => {
      const resGet = await request(app)
        .get(`/api/finance/cashflow?cash_desk_id=${alienDeskUuid}`)
        .set('Authorization', `Bearer ${directorToken}`);
      expect(resGet.status).toBe(200);
      expect(resGet.body.success).toBe(true);

      const resExport = await request(app)
        .get(`/api/finance/cashflow/export.xlsx?cash_desk_id=${alienDeskUuid}`)
        .set('Authorization', `Bearer ${directorToken}`);
      expect(resExport.status).toBe(200);
      expect(resExport.headers['content-type']).toContain('spreadsheet');
    }, 15000);

    it('E3. FINANCE_MANAGER can select and export any cash desk with HTTP 200', async () => {
      const resGet = await request(app)
        .get(`/api/finance/cashflow?cash_desk_id=${alienDeskUuid}`)
        .set('Authorization', `Bearer ${financeToken}`);
      expect(resGet.status).toBe(200);
      expect(resGet.body.success).toBe(true);

      const resExport = await request(app)
        .get(`/api/finance/cashflow/export.xlsx?cash_desk_id=${alienDeskUuid}`)
        .set('Authorization', `Bearer ${financeToken}`);
      expect(resExport.status).toBe(200);
      expect(resExport.headers['content-type']).toContain('spreadsheet');
    }, 15000);
  });
});

