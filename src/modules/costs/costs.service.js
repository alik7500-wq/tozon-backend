// Paid cash expenditure, not accrual or warehouse cost. No current FX rates.
export const canReadCosts = user => user?.role === 'ADMIN' || user?.permissions?.includes('*') || user?.permissions?.includes('finance.costs');
export const canWriteCosts = user => canReadCosts(user) && (user?.role === 'ADMIN' || user?.permissions?.includes('*') || user?.permissions?.includes('finance.costs.write'));

export function exclusionReason(e, advanceIds = new Set()) {
  if (e.voided_at || ['VOIDED', 'CANCELLED', 'REVERSED'].includes(e.status)) return 'Аннулирован';
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

export function buildCostReport({ buildings, bases, registry, expenses, allocations, advances, asOf }) {
  const advanceIds = new Set(advances.filter(d => d.status === 'POSTED' && d.kind === 'ADVANCE_ISSUE').map(d => d.expense_id));
  const byExpense = new Map(allocations.map(a => [a.expense_id, a]));
  const blocks = buildings.map(b => ({ ...b, basis: bases.find(a => a.building_id === b.id) || null,
    registry_area_m2: registry[b.id]?.area || 0, registry_unit_count: registry[b.id]?.count || 0,
    amount_usd_minor: 0, direct_usd_minor: 0, shared_usd_minor: 0, expense_count: 0, categories: {} }));
  const byBlock = new Map(blocks.map(b => [b.id, b]));
  const rows = [];
  for (const e of expenses) {
    if (e.expense_date > asOf) continue;
    const allocation = byExpense.get(e.id) || null;
    const automaticReason = exclusionReason(e, advanceIds);
    const value = usdMinor(e);
    let state = automaticReason ? 'AUTO_EXCLUDED' : !allocation ? 'UNASSIGNED' : allocation.mode;
    let reason = automaticReason || allocation?.reason || '';
    let portions = [];
    if (!automaticReason && ['DIRECT', 'SHARED'].includes(state)) {
      if (allocation.shares.some(s => !byBlock.has(Number(s.building_id)))) { state = 'UNASSIGNED'; reason = 'Блок недоступен; требуется перераспределение'; }
      else if (value === null) { state = 'MISSING_FX'; reason = 'Нет сохранённого USD-эквивалента или курса'; }
      else {
        portions = splitMinor(value, allocation.shares);
        for (const p of portions) {
          const b = byBlock.get(p.building_id);
          b.amount_usd_minor += p.amount;
          b[state === 'DIRECT' ? 'direct_usd_minor' : 'shared_usd_minor'] += p.amount;
          b.expense_count++;
          b.categories[e.category || 'Без статьи'] = (b.categories[e.category || 'Без статьи'] || 0) + p.amount;
        }
      }
    }
    rows.push({ id: e.id, reference: e.reference, date: e.expense_date, category: e.category, description: e.description,
      currency: e.currency, amount_minor: e.amount_minor, usd_minor: value, state, reason, allocation, portions });
  }
  for (const b of blocks) b.cost_per_m2_usd = b.basis ? b.amount_usd_minor / 100 / Number(b.basis.sellable_area_m2) : null;
  return { as_of: asOf, blocks, rows: rows.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id),
    totals: { allocated_usd_minor: blocks.reduce((n, b) => n + b.amount_usd_minor, 0),
      unassigned_count: rows.filter(r => r.state === 'UNASSIGNED').length,
      missing_fx_count: rows.filter(r => r.state === 'MISSING_FX' || (r.state === 'UNASSIGNED' && r.usd_minor == null)).length,
      excluded_count: rows.filter(r => ['EXCLUDED', 'AUTO_EXCLUDED'].includes(r.state)).length } };
}
