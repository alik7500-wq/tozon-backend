import { AppError } from '../../shared/errors/errorHandler.js';

export function validateBuildingAreas(body) {
  const fields = ['footprint_area_m2_x100', 'gross_floor_area_m2_x100'];
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      !Object.keys(body).length || Object.keys(body).some(key => !fields.includes(key))) {
    throw new AppError('Укажите только площади застройки и всех этажей', 400);
  }
  const result = {};
  for (const key of fields) {
    if (!Object.hasOwn(body, key)) continue;
    const value = body[key];
    if (value !== null && (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647)) {
      throw new AppError('Площадь должна быть положительным числом с точностью до 0,01 м²', 400);
    }
    result[key] = value;
  }
  return result;
}
