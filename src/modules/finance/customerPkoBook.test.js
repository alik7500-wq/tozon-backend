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
    expect(ws.getCell('B10').value).toBe('ПКО-98');expect(ws.getCell('C10').value).toBe("'=bad");expect(ws.getCell('G10').value).toBe(100);expect(ws.getCell('I10').value).toBe(926);expect(ws.getCell('M10').value).toBe('Аннулирован');
  });
  it('makes the register readable and totals each currency without voided receipts',async()=>{
    const rows=[
      {date:'2026-10-19',document_number:'ПКО-98',clientName:'Покупатель недвижимости',contract:'0045',amount:100,currency:'USD',amountTjs:926,status:'ACTIVE'},
      {date:'2026-10-18',document_number:'ПКО-97',amount:900,currency:'USD',status:'VOIDED'},
      {date:'2026-10-17',document_number:'ПКО-96',amount:300,currency:'TJS',status:'ACTIVE'}
    ];
    const wb=new ExcelJS.Workbook();await wb.xlsx.load(await customerBookWorkbook(rows));const ws=wb.worksheets[0];
    expect(ws.getCell('A2').value).toContain('КНИГА РЕГИСТРАЦИИ ПКО');
    expect(ws.getCell('A4').value).toContain('17.10.2026 — 19.10.2026');
    expect(ws.getCell('A6').value).toBe('Всего ПКО: 3');
    expect(ws.getCell('E6').value).toBe('Действующих: 2');
    expect(ws.getCell('A10').value).toEqual(new Date('2026-10-19T00:00:00Z'));
    expect(ws.getCell('D10').value).toBe('0045');
    expect(ws.getRow(10).height).toBeLessThanOrEqual(58);
    expect(ws.getCell('A9').fill.fgColor.argb).toBe('173C55');
    expect(ws.views[0]).toMatchObject({xSplit:2,ySplit:9,showGridLines:false});
    expect(ws.autoFilter).toBe('A9:M12');
    expect(ws.pageSetup).toMatchObject({orientation:'landscape',fitToWidth:1});
    expect(ws.getCell('G15').value).toMatchObject({result:300});
    expect(ws.getCell('H15').value).toBe('TJS');
    expect(ws.getCell('G16').value).toMatchObject({result:100});
    expect(ws.getCell('G16').value.formula).toContain('SUMIFS');
    expect(ws.getCell('H16').value).toBe('USD');
    expect(ws.conditionalFormattings).toHaveLength(2);
  });
  it('exports an empty book with headings and no invalid total formulas',async()=>{
    const wb=new ExcelJS.Workbook();await wb.xlsx.load(await customerBookWorkbook([]));const ws=wb.worksheets[0];
    expect(ws.getCell('A6').value).toBe('Всего ПКО: 0');
    expect(ws.getCell('A9').value).toBe('Дата');
    expect(ws.autoFilter).toBe('A9:M9');
    ws.eachRow(row=>row.eachCell(cell=>expect(cell.value?.formula).toBeUndefined()));
  });

});
