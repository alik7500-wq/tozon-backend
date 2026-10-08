import { AppError } from '../../shared/errors/errorHandler.js';

export function validateAmendment(data) {
  const allowed = ['unit_id', 'final_price_minor', 'deal_price_per_m2_minor', 'reason', 'expected_updated_at'];
  if (!data || Object.keys(data).some(key => !allowed.includes(key))) {
    throw new AppError('Недопустимые поля изменения договора', 400);
  }
  for (const key of ['unit_id', 'final_price_minor', 'deal_price_per_m2_minor']) {
    if (!Number.isSafeInteger(data[key]) || data[key] <= 0 || data[key] > 2147483647) {
      throw new AppError('Квартира и цены должны быть положительными целыми значениями', 400);
    }
  }
  if (typeof data.reason !== 'string' || !data.reason.trim() || data.reason.length > 2000) {
    throw new AppError('Укажите причину изменения договора (до 2000 символов)', 400);
  }
  if (typeof data.expected_updated_at !== 'string' || !Number.isFinite(Date.parse(data.expected_updated_at))) {
    throw new AppError('Обновите карточку договора перед изменением', 400);
  }
  return { ...data, reason: data.reason.trim() };
}
