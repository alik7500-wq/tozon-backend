import ExcelJS from 'exceljs';
import { isVoidedPko } from './customerPko.js';

export function filterCustomerBook(rows, filters = {}) {
  return rows.filter(p => (!filters.date_from || String(p.date).slice(0,10) >= filters.date_from)
    && (!filters.date_to || String(p.date).slice(0,10) <= filters.date_to)
    && (!filters.book_status || filters.book_status === 'ALL'
      || (filters.book_status === 'VOIDED' ? isVoidedPko(p) : !isVoidedPko(p))));
}

export async function customerBookWorkbook(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ПКО покупателей');
  ws.columns = [
    ['Дата','date',14],['№ ПКО','number',20],['Покупатель','buyer',32],['Договор','contract',18],
    ['Недвижимость','property',45],['Касса','desk',35],['Сумма учёта','amount',18],['Валюта учёта','currency',18],
    ['Сумма ПКО, TJS','tjs',20],['Курс','rate',12],['Способ оплаты','method',18],['Ответственный','user',24],['Статус','status',20]
  ].map(([header,key,width]) => ({header,key,width}));
  const safe = v => /^[=+@-]/.test(String(v || '')) ? "'"+v : String(v || '');
  for (const p of rows) ws.addRow({ date: String(p.date || '').slice(0,10),number:safe(p.document_number || p.reference),
    buyer:safe(p.clientName),contract:safe(p.contract),property:safe(p.property),desk:safe(p.cashDeskName),
    amount:p.amount,currency:p.currency,tjs:p.amountTjs ?? (p.currency==='TJS'?p.amount:null),rate:p.exchangeRate,
    method:safe(p.method),user:safe(p.createdByName),status:isVoidedPko(p)?'Аннулирован':'Действует' });
  ws.getRow(1).font={bold:true}; ws.views=[{state:'frozen',ySplit:1}];
  ws.autoFilter={from:'A1',to:`M${Math.max(1,rows.length+1)}`};
  ws.getColumn('amount').numFmt='#,##0.00';ws.getColumn('tjs').numFmt='#,##0.00';
  ws.pageSetup={orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0};
  return wb.xlsx.writeBuffer();
}
