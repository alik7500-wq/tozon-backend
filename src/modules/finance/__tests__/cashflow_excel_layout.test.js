import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';
vi.mock('../finance.repository.js', () => ({ FinanceRepository: { getCashflow: vi.fn(), getIncome: vi.fn() } }));
import { FinanceRepository } from '../finance.repository.js';
import { CashflowExcelService } from '../cashflow_excel.service.js';

const fixture = () => ({
  cashDesksSummary: [
    { name: 'Касса А', totalIncomeUsd: 120, totalExpenseUsd: 25, totalIncomeTjs: 0, totalExpenseTjs: 0 },
    { name: 'Касса Б', totalIncomeUsd: 0, totalExpenseUsd: 0, totalIncomeTjs: 500, totalExpenseTjs: 0 }
  ],
  transactions: [
    { id: 'inc-1', rawId: 1, type: 'INCOME', date: '2026-10-02', currency: 'USD', amount: 120, cashDeskName: 'Касса А' },
    { id: 'inc-2', rawId: 2, type: 'INCOME', date: '2026-10-01', currency: 'TJS', amount: 500, cashDeskName: 'Касса Б' },
    { id: 'exp-3', rawId: 3, type: 'EXPENSE', date: '2026-10-03', currency: 'USD', amount: 25, cashDeskName: 'Касса А' }
  ]
});
async function build(data, access = { isAdmin: true }) {
  FinanceRepository.getCashflow.mockResolvedValue(data);
  const book = new ExcelJS.Workbook();
  const buffer = await CashflowExcelService.generateExcelBuffer({}, access);
  await book.xlsx.load(buffer);
  book.exportXml = new PizZip(buffer).file('xl/workbook.xml').asText();
  return book;
}
describe('DDS export formula rows and separate cash desk ledgers', () => {
  beforeEach(() => { vi.clearAllMocks(); FinanceRepository.getIncome.mockResolvedValue({ list: [] }); });
  it('includes all-time investment contributions by investor without transfers or cancelled receipts', async () => {
    FinanceRepository.getIncome.mockResolvedValue({ list: [
      { payerName: 'Инвестор А', operationType: 'INVESTMENT', amount: 100, currency: 'USD' },
      { payerName: 'инвестор  а', contract: 'Инвестиция партнёра', amount: 900, currency: 'TJS', amountUsd: 90 },
      { payerName: 'Инвестор Б', operationType: 'INVESTMENT', amount: 40, currency: 'USD' },
      { payerName: 'Инвестор Б', operationType: 'INVESTMENT', amount: 50, currency: 'TJS' },
      { payerName: 'Инвестор Б', operationType: 'INVESTMENT', amount: 999, currency: 'USD', transferId: 'transfer' },
      { payerName: 'Инвестор Б', operationType: 'INVESTMENT', amount: 999, currency: 'USD', status: 'VOIDED' }
    ] });
    const access = { isAdmin: false, cashDeskId: 'own' };
    const book = await build(fixture(), access);
    const summary = book.getWorksheet('Свод по кассам');
    const rows = [];
    summary.eachRow(row => rows.push(row));
    expect(rows.find(r => r.getCell(1).value === 'Инвестор А').getCell(2).value).toBe(190);
    expect(rows.find(r => r.getCell(1).value === 'ВСЕГО ВНЕСЕНО, USD').getCell(2).result).toBe(230);
    expect(rows.some(r => String(r.getCell(1).value).includes('Без сохранённого USD-эквивалента: 1'))).toBe(true);
    expect(FinanceRepository.getIncome).toHaveBeenCalledWith({ year: 'ALL', currency: 'ALL' }, access);
  });
  it('calculates each ending balance on its own row, including the first desk', async () => {
    const book = await build(fixture());
    const summary = book.getWorksheet('Свод по кассам');
    expect(summary.getCell('G9').formula).toBe('B9+C9-D9');
    expect(summary.getCell('G10').formula).toBe('B10+C10-D10');
    expect(summary.getCell('M9').formula).toBe('H9+I9-J9');
    expect(summary.getCell('G11').formula).toBe('SUM(G9:G10)');
    const audit = book.getWorksheet('Сверка');
    expect(audit.getCell('C2').formula).toBe("SUM('Приходы ПКО'!K2:K3)");
    expect(audit.getCell('C3').formula).toBe("SUM('Расходы РКО'!K2:K2)");
    expect(audit.getCell('D4').formula).toBe("'Свод по кассам'!G11");
    expect(audit.getCell('C8').formula).toBe('SUMIF(\'Приходы ПКО\'!J2:J3,"TJS",\'Приходы ПКО\'!L2:L3)');
    expect(book.exportXml).toContain('fullCalcOnLoad="1"');
  });
  it('isolates desk transactions and rolls each currency balance forward', async () => {
    const book = await build(fixture());
    const a = book.getWorksheet('Касса 1 - Касса А');
    const b = book.getWorksheet('Касса 2 - Касса Б');
    expect(a.getCell('Q6').value).toBe(1);
    expect(a.getCell('Q7').value).toBe(3);
    expect(a.getCell('J7').value).toEqual({ formula: 'J6+H7-I7', result: 95 });
    expect(b.getCell('Q6').value).toBe(2);
    expect(b.getCell('M6').result).toBe(500);
    expect(a.getCell('M7').result).toBe(0);
  });
  it('has no invalid ranges for empty exports and passes access to the repository', async () => {
    const access = { isAdmin: false, cashDeskId: 'own' };
    const book = await build({ cashDesksSummary: [], transactions: [] }, access);
    expect(book.worksheets).toHaveLength(4);
    expect(book.getWorksheet('Сверка').getCell('C2').formula).toBe('0');
    expect(FinanceRepository.getCashflow).toHaveBeenCalledWith({}, access);
  });
  it('sanitizes sheet names and text while avoiding duplicate truncated names', async () => {
    const name = '=Danger/[name]:'.repeat(5);
    const book = await build({ cashDesksSummary: [{ name }, { name: name + '2' }], transactions: [] });
    const sheets = book.worksheets.filter(s => s.name.startsWith('Касса '));
    expect(sheets).toHaveLength(2);
    expect(sheets[0].name).not.toBe(sheets[1].name);
    expect(sheets[0].name.length).toBeLessThanOrEqual(31);
    expect(sheets[0].name).not.toMatch(/[\\/?*\[\]:]/);
    expect(sheets[0].getCell('B1').value).toBe("'" + name);
  });
});

it('exports non-cash barter loss separately from money and preserves the asset write-off',async()=>{
 const data=fixture();data.cashDesksSummary[0].nonCashAdjustmentUsd=-15;
 data.cashDesksSummary.push({name:'Результат бартера',isAnalytical:true,balanceUsd:-15,balanceTjs:-150,resultDetails:[{asset:'Genesis',date:'2026-10-28',costTjs:1000,proceedsTjs:850,sellingCostTjs:0,resultTjs:-150,resultUsd:-15}]});
 const book=await build(data);const sheet=book.getWorksheet('Свод по кассам');
 expect(sheet.getCell('P11').formula).toBe('SUM(P9:P10)');
 expect(book.getWorksheet('Сверка').getCell('C4').formula).toContain("'Свод по кассам'!P11");
 expect(sheet.getCell('G9').result).toBe(80);expect(sheet.getCell('G9').formula).toContain('+P9');
 expect(book.getWorksheet('Результат бартера').getCell('F3').value).toBe(-150);
 expect(sheet.getCell('A11').value).not.toBe('Результат бартера');
});
