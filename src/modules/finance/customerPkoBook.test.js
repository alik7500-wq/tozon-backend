import { describe,it,expect } from 'vitest';
import ExcelJS from 'exceljs';
import { isCustomerPko } from './customerPko.js';
import { filterCustomerBook, customerBookWorkbook } from './customerPkoBook.js';
const buyer={deal_id:1,operation_type:'STANDARD',settlement_method:'CASH'};
describe('buyer book classification and exports',()=>{
  it.each([{...buyer,method:'BANK_TRANSFER'},{...buyer,method:'CARD'},{...buyer,reference:'ПКО-ПЕРЕМ-100'},buyer])('includes customer money receipts based on financial type rather than manual label %j',p=>expect(isCustomerPko(p)).toBe(true));
  it.each([{...buyer,deal_id:null},{...buyer,settlement_method:'NON_CASH_BARTER'},{...buyer,transfer_id:'id'},{...buyer,conversion_id:'id'},{...buyer,operation_type:'INVESTMENT'}])('excludes noncustomer operations %j',p=>expect(isCustomerPko(p)).toBe(false));
  it('filters dates and preserves voided entries only when selected',()=>{
    const rows=[{date:'2026-10-19',status:'VOIDED'},{date:'2026-10-18',status:'ACTIVE'}];
    expect(filterCustomerBook(rows,{date_from:'2026-10-19'})).toEqual([rows[0]]);
    expect(filterCustomerBook(rows,{book_status:'ACTIVE'})).toEqual([rows[1]]);
  });
  it('exports official numbers, cash desks, amounts and voided status to a real workbook',async()=>{
    const buffer=await customerBookWorkbook([{date:'2026-10-19',document_number:'ПКО-98',reference:'old',clientName:'=bad',contract:'0045',cashDeskName:'Касса',amount:100,currency:'USD',amountTjs:926,exchangeRate:9.26,status:'VOIDED'}]);
    const wb=new ExcelJS.Workbook();await wb.xlsx.load(buffer);const ws=wb.worksheets[0];
    expect(ws.getCell('B2').value).toBe('ПКО-98');expect(ws.getCell('C2').value).toBe("'=bad");expect(ws.getCell('G2').value).toBe(100);expect(ws.getCell('I2').value).toBe(926);expect(ws.getCell('M2').value).toBe('Аннулирован');
  });
});
