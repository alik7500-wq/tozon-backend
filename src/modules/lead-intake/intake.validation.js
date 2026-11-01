import crypto from 'node:crypto';
import { AppError } from '../../shared/errors/errorHandler.js';
export const SOURCES = ['WEBINAR', 'GOOGLE_FORM', 'INSTAGRAM', 'WHATSAPP', 'IMPORT'];
export function normalizePhone(value) {
  let phone = String(value ?? '').trim().replace(/[\s().-]/g, '');
  if (phone.startsWith('00')) phone = '+' + phone.slice(2);
  if (!/^\+?\d+$/.test(phone)) return null;
  phone = phone.replace(/^\+/, '');
  if (phone.length === 9) phone = '992' + phone;
  return /^[1-9]\d{6,14}$/.test(phone) ? '+' + phone : null;
}
const clean = (value, max) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
export function normalizeRow(row = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) row = {};
  const data = { full_name: clean(row.full_name, 200), phone: normalizePhone(row.phone), notes: clean(row.notes, 4000), submitted_at: clean(row.submitted_at, 100) };
  const errors = [];
  if (!data.full_name) errors.push('Не указано имя');
  if (!data.phone) errors.push('Некорректный телефон: укажите номер с кодом страны или 9 цифр для Таджикистана');
  return { data, errors };
}
export function normalizeSettings(raw = {}) {
  if (!SOURCES.includes(raw.source)) throw new AppError('Выберите источник заявок', 400);
  const campaign = clean(raw.campaign, 160);
  if (!campaign) throw new AppError('Укажите название списка или вебинара', 400);
  const optionalId = value => {
    if (value === null || value === undefined || value === '') return null;
    if (!/^\d{1,9}$/.test(String(value)) || Number(value) < 1) throw new AppError('Некорректный объект или ответственный', 400);
    return Number(value);
  };
  return { source: raw.source, campaign, project_id: optionalId(raw.project_id), manager_id: optionalId(raw.manager_id) };
}
export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function prepareRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 500) throw new AppError('За один импорт можно загрузить от 1 до 500 строк', 400);
  const seen = new Set();
  return rows.map((row, index) => {
    const result = normalizeRow(row);
    const repeated = result.data.phone && seen.has(result.data.phone);
    if (result.data.phone && !result.errors.length) seen.add(result.data.phone);
    return { row: index + 1, ...result, repeated: !!repeated };
  });
}
