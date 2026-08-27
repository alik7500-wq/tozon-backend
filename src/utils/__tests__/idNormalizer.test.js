import { describe, it, expect } from 'vitest';
import { normalizeBigIntId, parseOptionalBigInt, parseRequiredBigInt } from '../idNormalizer.js';
import { AppError } from '../../shared/errors/errorHandler.js';

describe('idNormalizer Utility & Sentinel Shield', () => {
  describe('normalizeBigIntId', () => {
    it('correctly accepts valid positive integer numbers and strings', () => {
      expect(normalizeBigIntId(57)).toBe(57);
      expect(normalizeBigIntId('57')).toBe(57);
      expect(normalizeBigIntId('10002')).toBe(10002);
    });

    it('returns null for sentinel strings when not required', () => {
      expect(normalizeBigIntId('ALL')).toBeNull();
      expect(normalizeBigIntId('all')).toBeNull();
      expect(normalizeBigIntId('*')).toBeNull();
      expect(normalizeBigIntId('null')).toBeNull();
      expect(normalizeBigIntId('undefined')).toBeNull();
      expect(normalizeBigIntId('')).toBeNull();
      expect(normalizeBigIntId(null)).toBeNull();
      expect(normalizeBigIntId(undefined)).toBeNull();
    });

    it('throws AppError(400) when required and sentinel string is passed', () => {
      expect(() => normalizeBigIntId('ALL', { required: true, fieldName: 'project_id' }))
        .toThrowError(AppError);
      expect(() => normalizeBigIntId('ALL', { required: true, fieldName: 'project_id' }))
        .toThrowError(/Недопустимое значение project_id/);
    });

    it('throws AppError(400) when required and null/undefined is passed', () => {
      expect(() => normalizeBigIntId(null, { required: true, fieldName: 'deal_id' }))
        .toThrowError(AppError);
      expect(() => normalizeBigIntId(undefined, { required: true, fieldName: 'deal_id' }))
        .toThrowError(/Параметр deal_id обязателен/);
    });

    it('throws AppError(400) when non-numeric invalid string is passed for required field', () => {
      expect(() => normalizeBigIntId('abc', { required: true, fieldName: 'lead_id' }))
        .toThrowError(/положительным целым числом/);
      expect(() => normalizeBigIntId(-5, { required: true, fieldName: 'unit_id' }))
        .toThrowError(/положительным целым числом/);
      expect(() => normalizeBigIntId(0, { required: true, fieldName: 'unit_id' }))
        .toThrowError(/положительным целым числом/);
      expect(() => normalizeBigIntId(3.14, { required: true, fieldName: 'unit_id' }))
        .toThrowError(/положительным целым числом/);
    });
  });

  describe('parseOptionalBigInt', () => {
    it('safely converts valid IDs and returns null for any sentinel', () => {
      expect(parseOptionalBigInt('3')).toBe(3);
      expect(parseOptionalBigInt(3)).toBe(3);
      expect(parseOptionalBigInt('ALL')).toBeNull();
      expect(parseOptionalBigInt('all')).toBeNull();
      expect(parseOptionalBigInt('*')).toBeNull();
      expect(parseOptionalBigInt('')).toBeNull();
      expect(parseOptionalBigInt(null)).toBeNull();
      expect(parseOptionalBigInt(undefined)).toBeNull();
      expect(parseOptionalBigInt('invalid_id')).toBeNull();
    });
  });

  describe('parseRequiredBigInt', () => {
    it('returns parsed number for valid ID', () => {
      expect(parseRequiredBigInt('57', 'deal_id')).toBe(57);
      expect(parseRequiredBigInt(57, 'deal_id')).toBe(57);
    });

    it('throws HTTP 400 error on any sentinel value', () => {
      expect(() => parseRequiredBigInt('ALL', 'project_id')).toThrowError(AppError);
      expect(() => parseRequiredBigInt('all', 'project_id')).toThrowError(AppError);
      expect(() => parseRequiredBigInt('', 'project_id')).toThrowError(AppError);
      expect(() => parseRequiredBigInt(null, 'project_id')).toThrowError(AppError);
    });
  });
});
