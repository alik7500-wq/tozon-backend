import {formatDescription} from './number-format.js';
export const TIMEZONE = 'Asia/Dushanbe';
const invalidStatuses = new Set(['VOIDED', 'CANCELLED', 'REVERSED']);
const money = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function localDay(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}
export function validDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function dayOf(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return localDay(value);
}
export function periodFor(command, now = new Date()) {
  const today = localDay(now);
  if (command === 'month') return { from: today.slice(0, 8) + '01', to: today };
  if (command === 'yesterday') {
    const yesterday = new Date(Date.parse(today + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
    return { from: yesterday, to: yesterday };
  }
  return { from: today, to: today };
}
export function dailyDue(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', hourCycle: 'h23' }).format(now));
  return hour >= 22;
}
export function active(row) {
  return !invalidStatuses.has(row.status) && !row.voided_at;
}
export function internal(row) {
  // Conversion IDs group the exchange legs AND the actual expense paid afterwards.
  // Only an explicit exchange/transfer operation is internal; the linked РКО is external.
  return Boolean(row.transfer_id ||
    ['INTERNAL_CASH_TRANSFER', 'PAYMENT_ON_BEHALF', 'INTERNAL_TRANSFER', 'CONVERSION'].includes(row.operation_type) ||
    ['INTERNAL_TRANSFER', 'CONVERSION'].includes(row.settlement_method) ||
    ['Внутренние перемещения между кассами', 'Конвертация валюты', 'INTERNAL_TRANSFER', 'CURRENCY_CONVERSION'].includes(row.category) ||
    /ПЕРЕМ|КОНВ|ОБМЕН/i.test(row.reference || '') ||
    /Внутренн[еи]е перемещение|автоконвертаци|Поступление от обмена/i.test(row.comment || row.description || ''));
}
function nonCash(row, kind) {
  if (row.settlement_method) return row.settlement_method === 'NON_CASH_BARTER';
  // Same proven legacy barter documents as the existing CRM cash ledger.
  return (kind === 'income' ? [94, 96, 98] : [165, 167, 169]).includes(Number(row.id));
}
export function actualOperation(row,kind) {
  return active(row)&&!internal(row)&&!nonCash(row,kind);
}
export function expenseAmounts(row) {
  const currency=(row.currency||'USD').toUpperCase();
  const amount=Number(row.amount_minor||0)/100;
  const rate=Number(row.exchange_rate);
  const values={};
  if(currency==='TJS') {
    values.TJS=Number(row.amount_minor||0);
    const usd=Number(row.amount_usd)>0?Number(row.amount_usd):rate>0?amount/rate:null;
    if(usd!==null)values.USD=Math.round(usd*100);
  } else if(currency==='USD') {
    values.USD=Number(row.amount_minor||0);
    const legacy=(row.description||'').match(/([\d]+(?:[ \u00a0\u202f][\d]{3})*(?:[.,]\d{1,2})?)\s*(?:TJS|сомони|смн)\b/i);
    const original=Number(row.amount_tjs)>0?Number(row.amount_tjs):legacy?Number(legacy[1].replace(/[ \u00a0\u202f]/g,'').replace(',','.')):rate>0?amount*rate:null;
    if(original!==null)values.TJS=Math.round(original*100);
  } else values[currency]=Number(row.amount_minor||0);
  return values;
}
export function formatExpense(row) {
  const values=expenseAmounts(row);
  return formatAmounts(values)+(!Object.hasOwn(values,'USD')?' · USD: курс не указан':!Object.hasOwn(values,'TJS')?' · TJS: курс не указан':'');
}
function add(bucket, currency, minor) {
  const n = Number(minor || 0);
  if (!Number.isSafeInteger(n)) throw new Error('INVALID_FINANCIAL_AMOUNT');
  bucket[currency] = (bucket[currency] || 0) + n;
}
function resolveDesk(row, desks) {
  if (row.cash_desk_id) return desks.find(d => d.id === row.cash_desk_id)?.name || 'Касса вне активного справочника';
  const text = row.comment || row.description || '';
  const name = text.match(/\[Касса:\s*([^\]]+)\]/i)?.[1]?.trim();
  const matched = name && desks.find(d => d.name.toLowerCase() === name.toLowerCase());
  return matched?.name || 'Касса не указана — требуется сверка';
}

export function buildReport(snapshot, from, to, now = new Date()) {
  if (!validDay(from) || !validDay(to) || from > to || to > localDay(now)) throw new Error('INVALID_REPORT_PERIOD');
  const report = { from, to, updatedAt: now.toISOString(), sales: {}, salesCount: 0, area: 0, reservations: 0, income: {}, customerIncome: {}, expense: {}, desks: [], details: [] };
  const deskMap = new Map();
  const desks = snapshot.desks || [];
  for (const d of desks) {
    if (d.code === 'BANK_ACCOUNT' || /бартер/i.test(d.name)) continue;
    deskMap.set(d.name, { name: d.name, opening: {}, income: {}, expense: {}, closing: {} });
  }
  for (const [kind, rows] of [['income', snapshot.payments || []], ['expense', snapshot.expenses || []]]) {
    for (const row of rows) {
      if (!active(row) || nonCash(row, kind)) continue;
      const date = dayOf(kind === 'income' ? row.payment_date : row.expense_date);
      if (!date) throw new Error('MISSING_LEDGER_DATE');
      if (date > to || (row.created_at && new Date(row.created_at) > now)) continue;
      const currency = (row.currency || 'USD').toUpperCase();
      const amount = Number(row.amount_minor || 0);
      const sign = kind === 'income' ? 1 : -1;
      const inPeriod = date >= from;
      if (inPeriod && !internal(row)) {
        add(report[kind], currency, amount);
        if (kind === 'income' && row.deal_id) add(report.customerIncome, currency, amount);
        if (kind === 'expense') report.details.push({ ...row, date, currency, amount, category: row.category || 'Прочее', description: row.description || '' });
      }
      // Bank payments affect company movement, but not cash on hand.
      const desk = desks.find(d => d.id === row.cash_desk_id);
      if (row.settlement_method === 'BANK' || desk?.code === 'BANK_ACCOUNT') continue;
      const name = resolveDesk(row, desks);
      if (!deskMap.has(name)) deskMap.set(name, { name, opening: {}, income: {}, expense: {}, closing: {} });
      const summary = deskMap.get(name);
      add(summary.closing, currency, amount * sign);
      if (inPeriod) add(summary[kind], currency, amount);
      else add(summary.opening, currency, amount * sign);
    }
  }
  for (const d of snapshot.deals || []) {
    const date = dayOf(d.signed_at || d.deal_date);
    if (['SIGNED', 'COMPLETED'].includes(d.status) && date >= from && date <= to && (!d.signed_at || new Date(d.signed_at) <= now)) {
      report.salesCount++;
      add(report.sales, (d.currency || 'USD').toUpperCase(), d.final_price_minor);
      report.area += Number(d.area_m2_x100 || 0);
    }
    const reserved = dayOf(d.created_at);
    if (d.status === 'RESERVED' && reserved >= from && reserved <= to && new Date(d.created_at) <= now) report.reservations++;
  }
  report.desks = [...deskMap.values()];
  return report;
}
export function formatAmounts(values) {
  const entries = Object.entries(values).filter(([, n]) => n !== 0).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? entries.map(([c, n]) => `${money.format(n / 100)} ${c}`).join('; ') : '0,00';
}
export function renderReport(r, view = 'summary', role = 'PARTNER') {
  const lines = [`TOZON CRM · ${r.from === r.to ? r.from : r.from + ' — ' + r.to}`, `Обновлено: ${new Intl.DateTimeFormat('ru-RU', { timeZone: TIMEZONE, dateStyle: 'short', timeStyle: 'short' }).format(new Date(r.updatedAt))} (Худжанд)`];
  if (view === 'summary' || view === 'sales') lines.push('', `Подписанные договоры: ${r.salesCount}`, `Сумма продаж: ${formatAmounts(r.sales)}`, `Площадь: ${money.format(r.area / 100)} м²`, `Действующие брони, созданные за период: ${r.reservations}`);
  if (view === 'summary' || view === 'movement') lines.push('', `Поступления от покупателей: ${formatAmounts(r.customerIncome)}`, `Все внешние поступления: ${formatAmounts(r.income)}`, `Расходы всего: ${formatAmounts(r.expense)}`, 'Переводы между кассами, обмен валюты и бартер исключены из этих итогов.');
  if (view === 'summary' || view === 'cash' || view === 'movement') {
    lines.push('', 'Остатки по кассам на конец периода:');
    for (const d of r.desks) {
      lines.push(`${d.name}: ${formatAmounts(d.closing)}`);
      if (view === 'movement') lines.push(`  Начало: ${formatAmounts(d.opening)}; приход: ${formatAmounts(d.income)}; расход: ${formatAmounts(d.expense)}`);
    }
    lines.push('В движении отдельных касс учтены внутренние переводы и конвертации.');
  }
  if (view === 'details') {
    if (role !== 'OWNER') throw new Error('DETAILS_FORBIDDEN');
    lines.push('', `Расходы всего: ${formatAmounts(r.expense)}`);
    const sorted = [...r.details].sort((a, b) => b.date.localeCompare(a.date));
    for (const d of sorted.slice(0, 40)) {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date.split('-').reverse().join('.') : d.date;
      const reference = d.document_number || d.reference || (d.id ? `РКО-${d.id}` : 'Расход');
      lines.push('', `🧾 ${reference} · ${date}`,
        `Суммы: ${formatExpense(d)}`,
        `Кому: ${d.recipient || 'Не указан'}`,
        `Статья: ${d.category || 'Прочее'}`,
        `Назначение: ${formatDescription(d.description).slice(0, 1000) || 'Не указано'}`);
    }
    if (sorted.length > 40) lines.push('Показаны последние 40 расходов. Полный список — в CRM.');
  }
  lines.push('', 'Отчёт отражает текущие действующие документы CRM.');
  return lines.join('\n');
}

export function splitMessage(text, size = 3500) {
  const parts = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > size) { if (current) parts.push(current); current = ''; }
    let rest = line;
    while (rest.length > size) { parts.push(rest.slice(0, size)); rest = rest.slice(size); }
    current += (current ? '\n' : '') + rest;
  }
  if (current) parts.push(current);
  return parts;
}
