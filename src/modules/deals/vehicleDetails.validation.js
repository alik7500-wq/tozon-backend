import { AppError } from '../../shared/errors/errorHandler.js';

const limits = { brand_model: 160, production_year: 4, color: 80, registration_number: 40, vin: 32, registration_certificate: 160, mileage_km: 12, handover_date: 10, condition: 1000, accessories: 1000, encumbrances: 1000 };

export function validateVehicleDetails(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new AppError('Данные автомобиля должны быть объектом', 400);
  const result = {};
  for (const [key, input] of Object.entries(value)) {
    if (!Object.hasOwn(limits, key)) throw new AppError('Недопустимое поле данных автомобиля', 400);
    if (input === null || input === undefined || input === '') continue;
    if (typeof input !== 'string') throw new AppError('Поля автомобиля должны содержать текст', 400);
    const text = input.trim();
    if (!text) continue;
    if (text.length > limits[key]) throw new AppError('Слишком длинное поле данных автомобиля', 400);
    if (key === 'production_year' && (!/^\d{4}$/.test(text) || Number(text) < 1886 || Number(text) > 2100)) throw new AppError('Укажите корректный год выпуска автомобиля', 400);
    if (key === 'mileage_km' && !/^\d{1,9}$/.test(text)) throw new AppError('Пробег должен быть целым неотрицательным числом', 400);
    if (key === 'handover_date' && (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text)) throw new AppError('Укажите корректную дату передачи автомобиля', 400);
    result[key] = text;
  }
  return Object.keys(result).length ? result : null;
}
