import { describe, it, expect } from 'vitest';
import { normalizePhoneNumber } from '../../../utils/phoneNormalizer.js';

describe('phoneNormalizer Utility', () => {
  it('should normalize standard 9-digit Tajikistan numbers', () => {
    const result = normalizePhoneNumber('927779757');
    expect(result.isValid).toBe(true);
    expect(result.normalized).toBe('+992927779757');
  });

  it('should normalize numbers with spaces, dashes, and parentheses', () => {
    const result = normalizePhoneNumber('+992 (92) 777-97-57');
    expect(result.isValid).toBe(true);
    expect(result.normalized).toBe('+992927779757');
  });

  it('should normalize 992 prefix without leading plus', () => {
    const result = normalizePhoneNumber('992927779757');
    expect(result.isValid).toBe(true);
    expect(result.normalized).toBe('+992927779757');
  });

  it('should handle 00992 prefix', () => {
    const result = normalizePhoneNumber('00992 911 010 666');
    expect(result.isValid).toBe(true);
    expect(result.normalized).toBe('+992911010666');
  });

  it('should handle 10-digit number with leading 0', () => {
    const result = normalizePhoneNumber('0927779757');
    expect(result.isValid).toBe(true);
    expect(result.normalized).toBe('+992927779757');
  });

  it('should reject invalid short numbers', () => {
    const result = normalizePhoneNumber('12345');
    expect(result.isValid).toBe(false);
    expect(result.normalized).toBeNull();
    expect(result.error).toContain('Недопустимый формат');
  });

  it('should reject non-string or empty input', () => {
    expect(normalizePhoneNumber(null).isValid).toBe(false);
    expect(normalizePhoneNumber('').isValid).toBe(false);
    expect(normalizePhoneNumber(123456789).isValid).toBe(false);
  });
});
