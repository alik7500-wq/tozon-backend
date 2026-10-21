import { describe, expect, it } from 'vitest';
import { assertCommercialInstallTarget } from './commercial-install-guard.js';
const base = {
  COMMERCIAL_INSTALL_CONFIRM: 'ISOLATED_TEST_DATABASE',
  COMMERCIAL_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
  COMMERCIAL_DATABASE_URL: 'postgresql://postgres.abcdefghijklmnopqrst:password@pooler.example.com:5432/postgres',
};
describe('commercial installation target guard', () => {
  it('accepts an explicitly confirmed isolated target', () => {
    expect(assertCommercialInstallTarget(base).projectRef).toBe('abcdefghijklmnopqrst');
  });
  it('rejects missing confirmation', () => {
    expect(() => assertCommercialInstallTarget({...base, COMMERCIAL_INSTALL_CONFIRM: ''})).toThrow();
  });
  it('rejects TOZON production target', () => {
    expect(() => assertCommercialInstallTarget({...base, COMMERCIAL_SUPABASE_PROJECT_REF: 'yeslzrrcwgcqfxhgbrqk'})).toThrow();
  });
  it('rejects POPUTKI production URL', () => {
    expect(() => assertCommercialInstallTarget({...base, COMMERCIAL_DATABASE_URL: 'postgresql://postgres.xzvtjcqwmuezxyeerkki:pass@pooler.example.com:5432/postgres'})).toThrow();
  });
  it('rejects project mismatch', () => {
    expect(() => assertCommercialInstallTarget({...base, COMMERCIAL_SUPABASE_PROJECT_REF: 'zyxwvutsrqponmlkjihg'})).toThrow();
  });
  it('rejects non-PostgreSQL connection', () => {
    expect(() => assertCommercialInstallTarget({...base, COMMERCIAL_DATABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co'})).toThrow();
  });
});
