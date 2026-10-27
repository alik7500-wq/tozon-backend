import { AppError } from '../../shared/errors/errorHandler.js';
const fail = message => { throw new AppError(message, 400); };
export function validateScheme(body) {
  const name = String(body.name || '').trim();
  if (!name || name.length > 100) fail('Название схемы: от 1 до 100 символов');
  const project_id = Number(body.project_id);
  if (!Number.isSafeInteger(project_id) || project_id <= 0) fail('Выберите ЖК');
  if (!Array.isArray(body.rules) || !body.rules.length || body.rules.length > 30) fail('Добавьте от 1 до 30 условий');
  const seen = new Set();
  const rules = body.rules.map(row => {
    const payment_percent = Number(row.payment_percent), discount_percent = Number(row.discount_percent), months = Number(row.months);
    if ([row.payment_percent,row.discount_percent,row.months].some(x => x === '' || x == null) || !Number.isFinite(payment_percent) || payment_percent < 0 || payment_percent > 100 || Math.abs(Math.round(payment_percent*100)-payment_percent*100)>0.000001 || !Number.isFinite(discount_percent) || discount_percent < 0 || discount_percent >= 100 || Math.abs(Math.round(discount_percent*100)-discount_percent*100)>0.000001 || !Number.isInteger(months) || months < 0 || months > 120) fail('Проверьте проценты (до 2 знаков) и срок (0–120 месяцев)');
    if ((payment_percent === 100) !== (months === 0)) fail('Срок 0 месяцев допускается только при взносе 100%');
    if (seen.has(payment_percent)) fail('Процент первоначального взноса не должен повторяться');
    seen.add(payment_percent);
    return { payment_percent, discount_percent, months };
  }).sort((a,b) => a.payment_percent-b.payment_percent);
  for (const key of ['starts_on','ends_on']) if (body[key] && (!/^\d{4}-\d{2}-\d{2}$/.test(body[key]) || !Number.isFinite(new Date(body[key]).getTime()) || new Date(body[key]).toISOString().slice(0,10)!==body[key])) fail('Неверная дата действия скидки');
  if (body.starts_on && body.ends_on && body.starts_on > body.ends_on) fail('Дата окончания раньше начала');
  return { project_id, name, rules, is_active: body.is_active !== false, starts_on: body.starts_on || null, ends_on: body.ends_on || null };
}
export function validateSchemeSale(scheme, data, unit, today) {
  if (!scheme?.is_active || scheme.starts_on && scheme.starts_on > today || scheme.ends_on && scheme.ends_on < today) fail('Схема скидок недоступна или срок действия истёк');
  if (unit.unit_kind && unit.unit_kind !== 'APARTMENT') fail('Схема применяется к квартирам');
  const project = unit.floors?.sections?.buildings?.projects;
  if (Number(scheme.project_id) !== Number(project?.id)) fail('Схема относится к другому ЖК');
  if (data.discount_scheme_updated_at !== scheme.updated_at) fail('Схема скидок изменилась. Откройте оформление заново');
  const rule = scheme.rules.find(r => r.payment_percent === Number(data.discount_rule_payment_percent));
  if (!rule) fail('Условие скидки не найдено');
  const base = Math.round(Number(unit.area_m2_x100) * Number(unit.price_per_m2_minor) / 100);
  if (!Number.isSafeInteger(base) || base <= 0) fail('В карточке квартиры не задана базовая цена');
  const discount = Math.round(base * rule.discount_percent / 100), final = base-discount;
  if (Number(data.base_price_minor)!==base || Number(data.discount_minor)!==discount || Number(data.final_price_minor)!==final) fail('Цена не соответствует выбранной схеме скидок');
  const full = rule.payment_percent === 100;
  if (full ? data.payment_type !== 'FULL' : !['INSTALLMENT','PARTIAL_BARTER'].includes(data.payment_type)) fail('Тип оплаты не соответствует условию скидки');
  if (Number(data.installment_months)!==rule.months || Number(data.installment_interval_months ?? 1)!==1) fail('Срок рассрочки не соответствует условию скидки');
  if (Number(data.down_payment_minor)!==Math.round(final*rule.payment_percent/100)) fail('Первоначальный взнос не соответствует условию скидки');
  return { scheme_id: scheme.id, scheme_name: scheme.name, scheme_updated_at: scheme.updated_at, ...rule, base_price_minor: base, discount_minor: discount, final_price_minor: final };
}
