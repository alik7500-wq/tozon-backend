import ExcelJS from 'exceljs';
import { AppError } from '../../shared/errors/errorHandler.js';

export const isVoidedRko = row => ['VOIDED','CANCELLED','REVERSED'].includes(row.status) || Boolean(row.voided_at || row.voidedAt);
export const isRko = row => row.operation_type !== 'CONVERSION' && row.category !== 'Конвертация валюты' && !/^КОНВ-/i.test(row.reference || '');
const text = value => String(value ?? '');
const date = value => text(value).slice(0,10);
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
export function validateRkoFilters(filters = {}) {
  for (const key of ['date_from','date_to']) if (filters[key] && !validDate(filters[key])) throw new AppError('Укажите корректные даты периода',400);
  if (filters.date_from && filters.date_to && filters.date_from > filters.date_to) throw new AppError('Начало периода должно быть не позже его окончания',400);
  if (filters.book_status && !['ALL','ACTIVE','VOIDED'].includes(filters.book_status)) throw new AppError('Неверный статус РКО',400);
}
export async function getRkoBook(db, filters = {}, access) {
  validateRkoFilters(filters);
  if (!access) throw new AppError('Нет доступа к кассовой книге',403);
  const allowed = access.isAdmin ? null : (access.viewableDeskIds || (access.canView && access.cashDeskId ? [access.cashDeskId] : []));
  if (filters.cash_desk_id && allowed && !allowed.includes(filters.cash_desk_id)) throw new AppError('Нет доступа к выбранной кассе',403);
  if (allowed && !allowed.length) return {list:[],totalsByCurrency:{},availableCurrencies:[]};
  const all = [];
  // Fetch every page, including voided entries; apply desk isolation in the database query.
  for (let start=0;;start+=500) {
    let q=db.from('expenses').select('*, users:created_by_user_id(name)').order('expense_date',{ascending:false}).order('id',{ascending:false});
    if (filters.cash_desk_id) q=q.eq('cash_desk_id',filters.cash_desk_id);
    else if (allowed) q=q.in('cash_desk_id',allowed);
    if (filters.date_from) q=q.gte('expense_date',filters.date_from);
    if (filters.date_to) q=q.lte('expense_date',filters.date_to);
    const {data,error}=await q.range(start,start+499);
    if(error) throw error;
    all.push(...(data||[]));
    if(!data || data.length<500) break;
  }
  const {data:desks,error:deskError}=await db.from('dictionaries').select('id,name').eq('type','CASH_DESK');
  if(deskError) throw deskError;
  const names=new Map((desks||[]).map(d=>[d.id,d.name]));
  const currencies=new Set();
  const q=text(filters.search).trim().toLocaleLowerCase('ru-RU');
  const list=all.filter(isRko).map(e=>{
    const currency=text(e.currency || 'USD').toUpperCase();currencies.add(currency);
    return {...e, amount:Number(e.amount_minor||0)/100,currency,date:date(e.expense_date),
      reference:e.reference || `РКО-${e.id}`,cashDeskId:e.cash_desk_id,
      cashDeskName:names.get(e.cash_desk_id)||'Касса не указана',createdByName:e.users?.name||'—',
      description:text(e.description).replace(/\[IDEMP:[^\]]+\]\s*/gi,'').trim(),
      exchange_rate:e.exchange_rate==null?null:Number(e.exchange_rate),status:e.status||'ACTIVE'};
  }).filter(e=>(!filters.currency || filters.currency==='ALL' || e.currency===filters.currency)
    && (!filters.book_status || filters.book_status==='ALL' || (filters.book_status==='VOIDED' ? isVoidedRko(e) : !isVoidedRko(e)))
    && (!q || [e.document_number,e.reference,e.recipient,e.category,e.description,e.cashDeskName,e.createdByName].some(v=>text(v).toLocaleLowerCase('ru-RU').includes(q))));
  const totalsMinor={};
  for(const e of list) if(!isVoidedRko(e)) totalsMinor[e.currency]=(totalsMinor[e.currency]||0)+Number(e.amount_minor||0);
  return {list,totalsByCurrency:Object.fromEntries(Object.entries(totalsMinor).map(([c,n])=>[c,n/100])),availableCurrencies:[...currencies].sort()};
}
export async function rkoBookWorkbook(rows) {
  const wb=new ExcelJS.Workbook();wb.calcProperties.fullCalcOnLoad=true;wb.creator='TOZON CRM';wb.title='Книга регистрации РКО';
  const ws=wb.addWorksheet('Регистрация РКО');
  const columns=[['Дата','date',13],['№ РКО','number',18],['Получатель','recipient',30],['Статья расхода','category',26],['Основание','description',42],['Касса','desk',30],['Сумма','amount',18],['Валюта','currency',12],['Курс','rate',12],['Ответственный','user',24],['Статус','status',18]];
  ws.columns=columns.map(([,key,width])=>({key,width}));
  const safe=v=>/^[=+@-]/.test(text(v)) ? "'"+v : text(v);
  const heading=(n,value)=>{ws.mergeCells(n,1,n,11);ws.getCell(n,1).value=value;ws.getCell(n,1).font={name:'Arial',bold:true,size:n===2?16:11,color:{argb:'173C55'}};ws.getRow(n).height=26;};
  heading(2,'TOZON CRM / КНИГА РЕГИСТРАЦИИ РКО');
  heading(3,`Всего записей: ${rows.length} · Аннулированных: ${rows.filter(isVoidedRko).length}`);
  const dates=rows.map(r=>r.date).filter(Boolean).sort();
  heading(4,dates.length?`Даты записей: ${dates[0]} — ${dates.at(-1)}`:'За выбранные условия записей нет');
  heading(6,'Итоги по каждой валюте отдельно. Аннулированные РКО в итог не включены.');
  ws.getRow(8).values=columns.map(([h])=>h);ws.getRow(8).height=30;
  ws.getRow(8).eachCell(c=>{c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'173C55'}};c.font={name:'Arial',bold:true,color:{argb:'FFFFFF'}};c.alignment={vertical:'middle',wrapText:true};});
  for(const [i,e] of rows.entries()) {
    const r=ws.addRow({date:validDate(e.date)?new Date(e.date+'T00:00:00Z'):safe(e.date),number:safe(e.document_number||e.reference),recipient:safe(e.recipient),category:safe(e.category),description:safe(e.description),desk:safe(e.cashDeskName),amount:e.amount,currency:safe(e.currency),rate:e.exchange_rate,user:safe(e.createdByName),status:isVoidedRko(e)?'Аннулирован':'Действует'});
    const lines=Math.max(...columns.map(([,key,width])=>text(key==='date'?e.date:r.getCell(key).value).split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil(line.length/Math.max(8,width-3))),0)));
    r.height=Math.max(32,lines*15+10);
    r.eachCell({includeEmpty:true},c=>{c.font={name:'Arial',size:11,color:{argb:isVoidedRko(e)?'9F3446':'25384A'}};c.fill={type:'pattern',pattern:'solid',fgColor:{argb:isVoidedRko(e)?'FFF0F1':i%2?'F0F5FA':'FFFFFF'}};c.alignment={vertical:'middle',wrapText:true};c.border={bottom:{style:'hair',color:{argb:'DBE4EC'}}};});
    r.getCell('date').numFmt='dd.mm.yyyy';r.getCell('amount').numFmt='#,##0.00';r.getCell('rate').numFmt='0.0000';
  }
  const last=8+rows.length;let summary=last+2;heading(summary,'ИТОГИ ПО ДЕЙСТВУЮЩИМ РКО');
  for(const currency of [...new Set(rows.map(e=>e.currency))].sort()) {
    summary++;ws.getCell(summary,6).value='Итого';ws.getCell(summary,8).value=safe(currency);
    const minor=rows.filter(e=>e.currency===currency&&!isVoidedRko(e)).reduce((n,e)=>n+Math.round(e.amount*100),0);
    ws.getCell(summary,7).value={formula:`SUMIFS(G9:G${last},H9:H${last},"${text(currency).replaceAll('"','""')}",K9:K${last},"Действует")`,result:minor/100};ws.getCell(summary,7).numFmt='#,##0.00';ws.getRow(summary).font={name:'Arial',bold:true};
  }
  ws.views=[{state:'frozen',ySplit:8,xSplit:2,showGridLines:false}];ws.autoFilter=`A8:K${last}`;
  ws.pageSetup={paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,printTitlesRow:'8:8',printArea:`A1:K${summary}`};
  ws.headerFooter.oddFooter='&LTOZON CRM · Книга РКО&RСтраница &P из &N';
  return wb.xlsx.writeBuffer();
}
