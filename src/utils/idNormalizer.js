import { AppError } from '../shared/errors/errorHandler.js';

/**
 * List of sentinel strings commonly used in UI filters that MUST NEVER be passed as DB identifiers.
 */
const SENTINEL_STRINGS = new Set([
  'ALL',
  'all',
  '*',
  'null',
  'undefined',
  'NaN',
  'none',
  'NONE',
  'ALL_OBJECTS',
  'ALL_PROJECTS',
  ''
]);

/**
 * Normalizes an incoming identifier (BIGINT in PostgreSQL).
 * 
 * @param {any} value - The input value (number, string, null, undefined)
 * @param {Object} [options={}] - Validation and error handling options
 * @param {boolean} [options.required=false] - Whether the ID is strictly required
 * @param {string} [options.fieldName='id'] - The name of the field for descriptive error messages
 * @returns {number|null} Normalized positive integer or null
 */
export function normalizeBigIntId(value, options = {}) {
  const { required = false, fieldName = 'id' } = options;

  // Handle null / undefined
  if (value === null || value === undefined) {
    if (required) {
      throw new AppError(`Параметр ${fieldName} обязателен для заполнения`, 400);
    }
    return null;
  }

  // Handle string values & sentinel filters
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (SENTINEL_STRINGS.has(trimmed)) {
      if (required) {
        throw new AppError(`Недопустимое значение ${fieldName}: фильтр "${trimmed}" не является идентификатором`, 400);
      }
      return null;
    }
    value = trimmed;
  }

  const num = Number(value);

  // Validate positive integer
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
    if (required) {
      throw new AppError(`Параметр ${fieldName} должен быть положительным целым числом`, 400);
    }
    return null;
  }

  return num;
}

/**
 * Safely parse an optional foreign key / BIGINT. Returns number or null. Never returns sentinel strings or NaN.
 */
export function parseOptionalBigInt(value) {
  return normalizeBigIntId(value, { required: false });
}

/**
 * Strictly parse a required foreign key / BIGINT. Throws 400 AppError on invalid/sentinel values.
 */
export function parseRequiredBigInt(value, fieldName = 'id') {
  return normalizeBigIntId(value, { required: true, fieldName });
}
