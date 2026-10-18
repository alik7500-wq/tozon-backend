// Ordinary paid expenditure + used rebar/concrete. No current FX rates.
export const canReadCosts = user => user?.role === 'ADMIN' || user?.permissions?.includes('*') || user?.permissions?.includes('finance.costs');
export const canWriteCosts = user => canReadCosts(user) && (user?.role === 'ADMIN' || user?.permissions?.includes('*') || user?.permissions?.includes('finance.costs.write'));

export function exclusionReason(e, advanceIds = new Set()) {
  if (e.voided_at || ['VOIDED', 'CANCELLED', 'REVERSED'].includes(e.status)) return 'Аннулирован';
  if (e.status && e.status !== 'ACTIVE') return 'РКО не проведён';
  if (e.transfer_id || /TRANSFER/.test(e.operation_type || '') || ['INTERNAL_TRANSFER', 'Внутренние перемещения между кассами'].includes(e.category)) return 'Перемещение между кассами';
  if (e.operation_type === 'CONVERSION' || ['CURRENCY_CONVERSION', 'Конвертация валюты'].includes(e.category) || (e.conversion_id && !e.conversion_expense_id)) return 'Обмен валюты';
  if (advanceIds.has(e.id)) return 'Выдача под отчёт — ещё не расход';
  return null;
}

export function usdMinor(e) {
  if (!Number.isSafeInteger(Number(e.amount_minor)) || Number(e.amount_minor) <= 0) return null;
  if (e.currency === 'USD') return Number(e.amount_minor);
  if (e.currency !== 'TJS') return null;
  // A TJS row holds TJS in amount_minor. Recalculate after edits using its
  // historical rate, as older cash edit handlers do not refresh amount_usd.
  // Legacy rows already stored as USD take the USD branch above.
  const candidate = Number(e.exchange_rate) > 0
    ? Math.round(Number(e.amount_minor) / Number(e.exchange_rate))
    : (Number(e.amount_usd) > 0 ? Math.round(Number(e.amount_usd) * 100) : null);
  if (candidate !== null && Number.isSafeInteger(candidate) && candidate >= 0) return candidate;
  return null;
}

// Largest remainder preserves every cent; tie order is independent of UI order.
export function splitMinor(total, shares) {
  const weights = shares.map(s => BigInt(Math.round(Number(s.weight) * 100)));
  const sum = weights.reduce((n, w) => n + w, 0n);
  const rows = shares.map((s, i) => {
    const scaled = BigInt(total) * weights[i];
    return { building_id: Number(s.building_id), amount: Number(scaled / sum), remainder: scaled % sum };
  });
  rows.sort((a, b) => a.remainder === b.remainder ? a.building_id - b.building_id : a.remainder > b.remainder ? -1 : 1);
  const left = total - rows.reduce((n, r) => n + r.amount, 0);
  for (let i = 0; i < left; i++) rows[i % rows.length].amount++;
  return rows.map(({ building_id, amount }) => ({ building_id, amount }));
}

export function buildCostReport({ buildings, bases, registry, expenses, allocations, advances, asOf, materialUsages = [], materialPayments = [] }) {
  const advanceIds = new Set(advances.filter(d => d.status === 'POSTED' && d.kind === 'ADVANCE_ISSUE').map(d => d.expense_id));
  const byExpense = new Map(allocations.map(a => [a.expense_id, a]));
  const blocks = buildings.map(b => ({ ...b, basis: bases.find(a => a.building_id === b.id) || null,
    registry_area_m2: registry[b.id]?.area || 0, registry_unit_count: registry[b.id]?.count || 0,
    amount_usd_minor: 0, direct_usd_minor: 0, shared_usd_minor: 0, expense_count: 0, categories: {},
    ordinary_rko_usd_minor: 0, material_used_usd_minor: 0, material_paid_usd_minor: 0, unpaid_material_usd_minor: 0 }));
  const byBlock = new Map(blocks.map(b => [b.id, b]));
  const expenseMap = new Map(expenses.map(e => [e.id, e]));
  const activeUsageIds = new Set(materialUsages.filter(u => u.status === 'ACTIVE').map(u => u.id));
  materialPayments = materialPayments.filter(p => !p.status || p.status === 'ACTIVE');
  const cashLinked = new Map();
  for (const p of materialPayments.filter(p => activeUsageIds.has(p.usage_id))) cashLinked.set(p.expense_id, (cashLinked.get(p.expense_id) || 0) + Number(p.cash_usd_minor));
  const paymentProblems = [];
  const validPayments = materialPayments.filter(p => {
    const e = expenseMap.get(p.expense_id);
    if (!e || !activeUsageIds.has(p.usage_id)) { paymentProblems.push(p.id); return false; }
    if (e.expense_date > asOf) return false;
    if (exclusionReason(e, advanceIds) || usdMinor(e) == null || cashLinked.get(e.id) > usdMinor(e)) { paymentProblems.push(p.id); return false; }
    return true;
  });
  const rows = [];
  for (const e of expenses) {
    if (e.expense_date > asOf) continue;
    const allocation = byExpense.get(e.id) || null;
    const automaticReason = exclusionReason(e, advanceIds);
    const value = usdMinor(e);
    const linkedCash = Math.min(value || 0, cashLinked.get(e.id) || 0);
    const ordinaryValue = value == null ? null : value - linkedCash;
    let state = automaticReason ? 'AUTO_EXCLUDED' : !allocation ? 'UNASSIGNED' : allocation.mode;
    let reason = automaticReason || allocation?.reason || '';
    let portions = [];
    if (!automaticReason && value != null && linkedCash > 0 && ordinaryValue === 0) { state = 'MATERIAL_PAYMENT'; reason = 'Оплата бетона / арматуры; затраты учтены по использованию'; }
    if (!automaticReason && ['DIRECT', 'SHARED'].includes(state)) {
      if (allocation.shares.some(s => !byBlock.has(Number(s.building_id)))) { state = 'UNASSIGNED'; reason = 'Блок недоступен; требуется перераспределение'; }
      else if (value === null) { state = 'MISSING_FX'; reason = 'Нет сохранённого USD-эквивалента или курса'; }
      else {
        portions = splitMinor(ordinaryValue, allocation.shares);
        for (const p of portions) {
          const b = byBlock.get(p.building_id);
          b.amount_usd_minor += p.amount;
          b.ordinary_rko_usd_minor += p.amount;
          b[state === 'DIRECT' ? 'direct_usd_minor' : 'shared_usd_minor'] += p.amount;
          b.expense_count++;
          b.categories[e.category || 'Без статьи'] = (b.categories[e.category || 'Без статьи'] || 0) + p.amount;
        }
      }
    }
    rows.push({ id: e.id, reference: e.reference, date: e.expense_date, category: e.category, description: e.description,
      currency: e.currency, amount_minor: e.amount_minor, usd_minor: value, material_payment_usd_minor: linkedCash,
      available_material_payment_usd_minor: value == null ? null : Math.max(0, value - (cashLinked.get(e.id) || 0)), state, reason, allocation, portions });
  }
  const materialRows = materialUsages.map(u => {
    const paidLinks = validPayments.filter(p => p.usage_id === u.id);
    const paid = Math.min(Number(u.amount), paidLinks.reduce((n, p) => n + Number(p.paid_amount), 0));
    const unpaid = Math.max(0, Math.round((Number(u.amount) - paid) * 100) / 100);
    const value = usdMinor({ ...u, amount_minor: Math.round(Number(u.amount) * 100) });
    const unpaidUsd = unpaid === 0 ? 0 : usdMinor({ ...u, amount_minor: Math.round(unpaid * 100) });
    const included = u.status === 'ACTIVE' && u.usage_date <= asOf && byBlock.has(u.building_id) && value != null && unpaidUsd != null;
    if (included) {
      const b = byBlock.get(u.building_id);
      b.material_used_usd_minor += value;
      b.material_paid_usd_minor += value - unpaidUsd;
      b.unpaid_material_usd_minor += unpaidUsd;
      b.amount_usd_minor += value;
      const category = u.material_kind === 'REBAR' ? 'Арматура по фактическому использованию' : 'Бетон по фактической заливке';
      b.categories[category] = (b.categories[category] || 0) + value;
    }
    return { ...u, usd_minor: value, paid_amount: paid, unpaid_amount: unpaid, unpaid_usd_minor: unpaidUsd, included,
      payments: materialPayments.filter(p => p.usage_id === u.id).map(p => ({ ...p, valid: validPayments.includes(p), reference: expenseMap.get(p.expense_id)?.reference, expense_date: expenseMap.get(p.expense_id)?.expense_date })) };
  });
  for (const b of blocks) b.paid_cost_usd_minor = b.ordinary_rko_usd_minor + b.material_paid_usd_minor;
  for (const b of blocks) b.cost_per_m2_usd = b.basis ? b.amount_usd_minor / 100 / Number(b.basis.sellable_area_m2) : null;
  return { as_of: asOf, blocks, material_usages: materialRows, material_payment_problems: paymentProblems, rows: rows.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id),
    totals: { allocated_usd_minor: blocks.reduce((n, b) => n + b.amount_usd_minor, 0),
      unassigned_count: rows.filter(r => r.state === 'UNASSIGNED').length,
      missing_fx_count: rows.filter(r => r.state === 'MISSING_FX' || (r.state === 'UNASSIGNED' && r.usd_minor == null)).length,
      excluded_count: rows.filter(r => ['EXCLUDED', 'AUTO_EXCLUDED'].includes(r.state)).length } };
}
