import {expenseAmounts,formatAmounts} from './report.js';
const number=new Intl.NumberFormat('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2});
export const formatNumber = value => number.format(Number(value));
export function formatDescription(value) {
 return String(value || '').replace(/(\d+[.,]\d+)(?=\s*(?:TJS|USD|RUB)\b)/g, value => formatNumber(value.replace(',', '.')))
  .replace(/(по курсу\s+)(\d+(?:[.,]\d+)?)/gi, (_, prefix, value) => prefix + formatNumber(value.replace(',', '.')));
}
export function escapeText(value,max=600){return String(value||'').replace(/[\r\n]+/g,' ').slice(0,max).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
export function readableDate(value){const d=String(value||'').slice(0,10);return /^\d{4}-\d{2}-\d{2}$/.test(d)?d.slice(8,10)+'.'+d.slice(5,7)+'.'+d.slice(0,4):escapeText(value,40);}
export function ledgerMessage(rows,kind,desk,desks,offset){
 const income=kind==='income';
 const cashName=desk?desks.find(d=>d.id===desk)?.name||'Касса':'Все кассы';
 const lines=[income?'📥 <b>Поступления в кассу</b>':'📤 <b>Расходы из кассы</b>',escapeText(cashName,200),rows.length?`Операции ${offset+1}–${offset+rows.length}`:'Операций нет'];
 if(!income&&rows.length)lines.push('Один расход показан в двух валютах по курсу операции.');
 for(const r of rows){
  const ref=r.document_number||r.reference||(income?'ПКО-':'РКО-')+r.id;
  lines.push('',`🧾 <b>${escapeText(ref,100)}</b> · ${readableDate(r.payment_date||r.expense_date)}`);
  if(income){
   const currency=(r.currency||'USD').toUpperCase();const labels={TJS:'Сомони',USD:'Доллары',RUB:'Рубли'};
   lines.push(`${labels[currency]||escapeText(currency,10)}: <b>${number.format(Number(r.amount_minor||0)/100)}</b>`);
  }else{
   const amounts=expenseAmounts(r);
   lines.push(`Сомони: <b>${amounts.TJS!==undefined?number.format(amounts.TJS/100):'курс не указан'}</b>`,`Доллары: <b>${amounts.USD!==undefined?number.format(amounts.USD/100):'курс не указан'}</b>`);
   if(amounts.TJS===undefined&&amounts.USD===undefined)lines.push('Сумма: '+escapeText(formatAmounts(amounts),100));
  }
  const person=income?(r.payer_name?.trim()||r.deals?.leads?.full_name):r.recipient;
  lines.push(`${income?'От кого':'Кому'}: ${escapeText(person||'Не указан',200)}`);
  if(!income)lines.push('Категория: '+escapeText(r.category||'Прочие расходы',150));
  const description=formatDescription((income?r.comment:r.description)||'').replace(/\[Касса:\s*[^\]]*\]\s*/gi,'').trim();
  const purpose=description||'Не указано';
  lines.push((income?'Основание: ':'За что: ')+escapeText(purpose.slice(0,500),500));
  for(let start=500;start<purpose.length;start+=500)lines.push(escapeText(purpose.slice(start,start+500),500));
  if(!desk)lines.push('Касса: '+escapeText(desks.find(d=>d.id===r.cash_desk_id)?.name||'Не указана',200));
 }
 return lines.join('\n');
}
