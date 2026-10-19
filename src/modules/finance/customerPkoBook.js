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
  wb.creator = 'TOZON CRM';
  wb.title = 'Книга регистрации ПКО покупателей недвижимости';
  wb.subject = 'Поступления от покупателей недвижимости';
  const ws = wb.addWorksheet('ПКО покупателей', { properties: { tabColor: { argb: '173C55' } } });
  const navy = '173C55', muted = '64748B', line = 'DBE4EC';
  const fill = color => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: color } });
  const moneyFormat = '#,##0.00;[Red](#,##0.00);0.00';
  const columns = [
    ['Дата','date',13],['№ ПКО','number',18],['Покупатель','buyer',32],['Договор №','contract',16],
    ['Недвижимость','property',40],['Касса','desk',29],['Сумма учёта','amount',18],['Валюта учёта','currency',12],
    ['Сумма ПКО, TJS','tjs',20],['Курс','rate',12],['Способ оплаты','method',21],['Ответственный','user',26],['Статус','status',18]
  ];
  ws.columns = columns.map(([,key,width]) => ({key,width}));
  function heading(range, text, size = 11, color = navy) {
    ws.mergeCells(range);
    const cell = ws.getCell(range.split(':')[0]);
    cell.value = text;
    cell.font = { name: 'Arial', size, bold: true, color: { argb: color } };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  }
  heading('A2:M2', 'TOZON CRM  /  КНИГА РЕГИСТРАЦИИ ПКО', 16);
  ws.getRow(2).height = 28;
  heading('A3:M3', 'Поступления от покупателей недвижимости', 11);
  ws.getRow(3).height = 23;
  const dates = rows.map(p => String(p.date || '').slice(0,10)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const displayDate = d => d.split('-').reverse().join('.');
  heading('A4:M4', dates.length ? `Даты записей: ${displayDate(dates[0])} — ${displayDate(dates.at(-1))}` : 'За выбранные условия записей нет', 11, muted);
  ws.getRow(4).height = 22;
  for (let c = 1; c <= 13; c++) ws.getCell(4,c).border = { bottom: { style: 'thin', color: {argb: line} } };
  const voided = rows.filter(isVoidedPko).length;
  heading('A6:D6', `Всего ПКО: ${rows.length}`);
  heading('E6:H6', `Действующих: ${rows.length - voided}`, 11, '166552');
  heading('I6:M6', `Аннулированных: ${voided}`, 11, '9F3446');
  ws.getRow(6).height = 26;
  heading('A7:M7', 'Итоги ниже рассчитаны по действующим ПКО отдельно для каждой валюты. Аннулированные записи сохранены в книге.', 11, muted);
  ws.getRow(7).height = 23;
  const headerRow = 9, firstDataRow = 10;
  ws.getRow(headerRow).values = columns.map(([header]) => header);
  ws.getRow(headerRow).height = 34;
  ws.getRow(headerRow).eachCell(cell => {
    cell.fill = fill(navy);
    cell.font = { name: 'Arial', size: 11, bold: true, color: {argb: 'FFFFFF'} };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = { right: { style: 'thin', color: {argb: 'FFFFFF'} } };
  });
  const safe = v => /^[=+@-]/.test(String(v || '')) ? "'"+v : String(v || '');
  const methods = { CASH: 'Наличные', BANK_TRANSFER: 'Банковский перевод', CARD: 'Карта', OTHER: 'Прочее' };
  for (const [index, p] of rows.entries()) {
    const dateText = String(p.date || '').slice(0,10);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? new Date(`${dateText}T00:00:00Z`) : null;
    const row = ws.addRow({ date: date && !Number.isNaN(date.getTime()) ? date : safe(dateText),
      number:safe(p.document_number || p.reference), buyer:safe(p.clientName), contract:safe(p.contract),
      property:safe(p.property), desk:safe(p.cashDeskName), amount:p.amount, currency:safe(p.currency),
      tjs:p.amountTjs ?? (p.currency==='TJS'?p.amount:null), rate:p.exchangeRate,
      method:safe(methods[p.method] || p.method), user:safe(p.createdByName), status:isVoidedPko(p)?'Аннулирован':'Действует' });
    // Fit wrapped names and property descriptions without cutting off text.
    const lines = Math.max(...columns.map(([,key,width]) => String(key === 'date' ? dateText : row.getCell(key).value ?? '').split('\n')
      .reduce((count,part) => count + Math.max(1,Math.ceil(part.length / Math.max(8,width-3))), 0)));
    row.height = Math.max(32, lines * 16 + 10);
    row.eachCell({includeEmpty:true}, cell => {
      cell.font = { name: 'Arial', size: 11, color: {argb: '25384A'} };
      cell.fill = fill(index % 2 ? 'F0F5FA' : 'FFFFFF');
      cell.alignment = { horizontal: typeof cell.value === 'number' ? 'right' : 'left', vertical: 'middle', wrapText: true };
      cell.border = { bottom: { style: 'hair', color: {argb: line} } };
    });
    row.getCell('date').numFmt = 'dd.mm.yyyy';
    row.getCell('number').font = { name: 'Arial', size: 11, bold: true, color: {argb: navy} };
    for (const key of ['amount','tjs']) row.getCell(key).numFmt = moneyFormat;
    row.getCell('rate').numFmt = '0.0000';
    for (const key of ['date','currency','status']) row.getCell(key).alignment = {horizontal:'center',vertical:'middle',wrapText:true};
  }
  const lastDataRow = headerRow + rows.length;
  if (rows.length) {
    ws.addConditionalFormatting({ ref: `A${firstDataRow}:M${lastDataRow}`, rules: [{ type:'expression', formulae:[`$M${firstDataRow}="Аннулирован"`],
      style:{fill:fill('FFF0F1'),font:{color:{argb:'9F3446'}}} }] });
    ws.addConditionalFormatting({ ref: `M${firstDataRow}:M${lastDataRow}`, rules: [{ type:'expression', formulae:[`$M${firstDataRow}="Действует"`],
      style:{fill:fill('E4F3EB'),font:{bold:true,color:{argb:'166552'}}} }] });
  }
  let summaryRow = Math.max(firstDataRow, lastDataRow + 2);
  heading(`A${summaryRow}:M${summaryRow}`, 'ИТОГИ ПО ДЕЙСТВУЮЩИМ ПКО', 11);
  ws.getRow(summaryRow).height = 26;
  const currencies = [...new Set(rows.map(p => p.currency).filter(Boolean))].sort();
  for (const currency of currencies) {
    summaryRow++;
    heading(`A${summaryRow}:F${summaryRow}`, `Сумма учёта — ${safe(currency)}`);
    ws.getCell(summaryRow,8).value = safe(currency);
    const result = rows.filter(p => p.currency === currency && !isVoidedPko(p)).reduce((sum,p) => sum + (Number(p.amount) || 0),0);
    const escapedCurrency = String(currency).replaceAll('"','""');
    ws.getCell(summaryRow,7).value = {formula:`SUMIFS(G${firstDataRow}:G${lastDataRow},H${firstDataRow}:H${lastDataRow},"${escapedCurrency}",M${firstDataRow}:M${lastDataRow},"Действует")`,result};
    ws.getCell(summaryRow,7).numFmt = moneyFormat;
    ws.getRow(summaryRow).height = 25;
    for (let c=1;c<=8;c++) {
      const cell=ws.getCell(summaryRow,c);
      cell.fill=fill('EAF0F6');
      cell.font={name:'Arial',size:11,bold:true,color:{argb:navy}};
    }
  }
  ws.views = [{state:'frozen',ySplit:headerRow,xSplit:2,topLeftCell:'C10',activeCell:'C10',showGridLines:false,zoomScale:80}];
  ws.autoFilter = { from:`A${headerRow}`,to:`M${Math.max(headerRow,lastDataRow)}` };
  ws.pageSetup = { paperSize:8,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,
    printArea:`A1:M${summaryRow}`,printTitlesRow:`${headerRow}:${headerRow}`,
    margins:{left:0.25,right:0.25,top:0.35,bottom:0.35,header:0.15,footer:0.15} };
  ws.headerFooter.oddFooter = '&LTOZON CRM · Книга ПКО покупателей&RСтраница &P из &N';
  return wb.xlsx.writeBuffer();
}
