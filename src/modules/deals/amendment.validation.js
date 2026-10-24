import { validateVehicleDetails } from './vehicleDetails.validation.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export function validateAmendment(data) {
  const allowed = ['unit_id', 'final_price_minor', 'deal_price_per_m2_minor', 'reason', 'expected_updated_at', 'down_payment_minor', 'payment_type', 'barter_amount_minor', 'barter_description', 'vehicle_details'];
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
  for (const key of ['down_payment_minor', 'barter_amount_minor']) {
    if (data[key] !== undefined && (!Number.isSafeInteger(data[key]) || data[key] < 0 || data[key] > 2147483647)) throw new AppError('Первоначальный взнос и стоимость бартера должны быть неотрицательными суммами', 400);
  }
  if (data.payment_type !== undefined && !['FULL', 'INSTALLMENT', 'PARTIAL_BARTER'].includes(data.payment_type)) throw new AppError('Недопустимая форма оплаты', 400);
  if (data.barter_description !== undefined && (typeof data.barter_description !== 'string' || data.barter_description.length > 2000)) throw new AppError('Описание бартера — до 2000 символов', 400);
  if (data.down_payment_minor !== undefined && data.down_payment_minor > data.final_price_minor) throw new AppError('Первоначальный взнос не может превышать стоимость договора', 400);
  if (data.barter_amount_minor !== undefined && data.down_payment_minor !== undefined && data.barter_amount_minor > data.down_payment_minor) throw new AppError('Стоимость автомобиля должна входить в первоначальный взнос', 400);
  return { ...data, reason: data.reason.trim(), ...(data.vehicle_details !== undefined ? {vehicle_details:validateVehicleDetails(data.vehicle_details)} : {}) };
}
