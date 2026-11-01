import { it, expect, vi } from 'vitest';
import { VG_CASH_DESK_ID, accountingScope, matchesAccountingScope, assertSameAccountingScope } from '../accountingScope.js';
const { db } = vi.hoisted(() => ({ db: { from: vi.fn() } }));
vi.mock('../../../db/connection.js', () => ({ getDB: () => db, getServiceDB: () => db }));
import { FinanceRepository } from '../finance.repository.js';
import { CashflowExcelService } from '../cashflow_excel.service.js';
import ExcelJS from 'exceljs';
const project = id => ({units:{floors:{sections:{buildings:{project_id:id}}}}});
it('defaults to AB, rejects unknown scopes, and protects VG even if a legacy document used another desk', () => {
  expect(accountingScope()).toBe('AB'); expect(() => accountingScope({accounting_scope:'ALL'})).toThrow();
  expect(matchesAccountingScope({cash_desk_id:VG_CASH_DESK_ID},'AB')).toBe(false);
  expect(matchesAccountingScope({cash_desk_id:'other', deals:project(4)},'AB')).toBe(false);
  expect(() => assertSameAccountingScope(VG_CASH_DESK_ID,'other')).toThrow();
  expect(() => assertSameAccountingScope('one','two')).not.toThrow();
  expect(() => assertSameAccountingScope(VG_CASH_DESK_ID,VG_CASH_DESK_ID)).not.toThrow();
});
it('isolates all report totals, cash balances, sales KPI, transactions and Excel', async () => {
  const tables={dictionaries:[{id:'ab',code:'MAIN_CASHIER',name:'Касса АБ'},{id:VG_CASH_DESK_ID,code:'TOZON_PLAZA_2_CASH',name:'Касса ВГ'}],
    payments:[{id:1,deal_id:1,deals:project(3),cash_desk_id:'ab',amount_minor:10000,currency:'USD',payment_date:'2026-11-01',status:'ACTIVE'}, {id:2,deal_id:2,deals:project(4),cash_desk_id:VG_CASH_DESK_ID,amount_minor:50000,currency:'USD',payment_date:'2026-11-01',status:'ACTIVE'}],
    expenses:[{id:3,cash_desk_id:'ab',amount_minor:2000,currency:'USD',expense_date:'2026-11-01',status:'ACTIVE'}, {id:4,cash_desk_id:VG_CASH_DESK_ID,amount_minor:10000,currency:'USD',expense_date:'2026-11-01',status:'ACTIVE'}],
    deals:[{id:1,status:'SIGNED',final_price_minor:10000,...project(3),deal_payment_schedules:[{paid_amount_minor:10000}]},{id:2,status:'SIGNED',final_price_minor:50000,...project(4),deal_payment_schedules:[{paid_amount_minor:50000}]}]};
  db.from.mockImplementation(table=>{const q={select:()=>q,eq:()=>q,order:()=>q,then:r=>r({data:tables[table]||[],error:null})};return q;});
  vi.spyOn(FinanceRepository,'getAvailableYears').mockResolvedValue([2026]);
  const ab=await FinanceRepository.getCashflow({year:2026},{isAdmin:true});
  expect(ab.summaryByCurrency.USD).toMatchObject({totalIncome:100,totalExpense:20,netCashflow:80});
  expect(ab.cashDesksSummary.map(d=>d.name)).toEqual(['Касса АБ']);
  expect(ab.transactions.map(t=>t.rawId).sort()).toEqual([1,3]);
  expect(ab.salesSummary.totalContractSumUsd).toBe(100);
  const vg=await FinanceRepository.getCashflow({year:2026,accounting_scope:'VG'},{isAdmin:true});
  expect(vg.summaryByCurrency.USD).toMatchObject({totalIncome:500,totalExpense:100,netCashflow:400});
  expect(vg.cashDesksSummary.map(d=>d.name)).toEqual(['Касса ВГ']);
  expect(vg.transactions.map(t=>t.rawId).sort()).toEqual([2,4]);
  expect(vg.salesSummary.totalContractSumUsd).toBe(500);
  vi.spyOn(FinanceRepository,'getIncome').mockResolvedValue({list:[]});
  const buffer=await CashflowExcelService.generateExcelBuffer({year:2026},{isAdmin:true});
  const book=new ExcelJS.Workbook();await book.xlsx.load(buffer);
  const values=[];book.eachSheet(sheet=>sheet.eachRow(row=>values.push(JSON.stringify(row.values))));
  expect(values.join('\n')).not.toContain('Касса ВГ');
});
