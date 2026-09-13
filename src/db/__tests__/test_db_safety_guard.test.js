import { describe, it, expect } from 'vitest';
import { assertSafeTestDatabase } from '../connection.js';

describe('Test Database Safety Guard (assertSafeTestDatabase)', () => {
  it('1. NODE_ENV=test + Production Supabase ref -> throws FATAL_TEST_DATABASE_IS_PRODUCTION', () => {
    const env = {
      NODE_ENV: 'test',
      TEST_SUPABASE_URL: 'https://yeslzrrcwgcqfxhgbrqk.supabase.co',
      SUPABASE_URL: 'https://yeslzrrcwgcqfxhgbrqk.supabase.co',
    };
    expect(() => assertSafeTestDatabase(env)).toThrow('FATAL_TEST_DATABASE_IS_PRODUCTION');
  });

  it('2. NODE_ENV=test + Production postgres hostname -> throws FATAL_TEST_DATABASE_IS_PRODUCTION', () => {
    const env = {
      NODE_ENV: 'test',
      TEST_DATABASE_URL: 'postgresql://postgres:pass@db.yeslzrrcwgcqfxhgbrqk.supabase.co:5432/postgres',
    };
    expect(() => assertSafeTestDatabase(env)).toThrow('FATAL_TEST_DATABASE_IS_PRODUCTION');
  });

  it('3. NODE_ENV=test + no dedicated TEST DB config -> throws TEST_DATABASE_CONFIGURATION_REQUIRED', () => {
    const env = {
      NODE_ENV: 'test',
      SUPABASE_URL: 'https://other-project.supabase.co',
    };
    expect(() => assertSafeTestDatabase(env)).toThrow('TEST_DATABASE_CONFIGURATION_REQUIRED');
  });

  it('4. NODE_ENV=test + dedicated test PostgreSQL URL -> allowed', () => {
    const env = {
      NODE_ENV: 'test',
      TEST_DATABASE_URL: 'postgresql://postgres:pass@localhost:5432/test_db',
    };
    expect(assertSafeTestDatabase(env)).toBe(true);
  });

  it('5. Normal Production or Development backend runtime -> unaffected', () => {
    const devEnv = {
      NODE_ENV: 'development',
      SUPABASE_URL: 'https://yeslzrrcwgcqfxhgbrqk.supabase.co',
    };
    const prodEnv = {
      NODE_ENV: 'production',
      SUPABASE_URL: 'https://yeslzrrcwgcqfxhgbrqk.supabase.co',
    };
    expect(assertSafeTestDatabase(devEnv)).toBe(true);
    expect(assertSafeTestDatabase(prodEnv)).toBe(true);
  });

  it('6. Fixture helper cannot bypass guard when connected to Production', () => {
    const helperExecution = (env) => {
      assertSafeTestDatabase(env);
      return 'created_fixture';
    };
    const badEnv = {
      NODE_ENV: 'test',
      TEST_SUPABASE_URL: 'https://yeslzrrcwgcqfxhgbrqk.supabase.co',
    };
    expect(() => helperExecution(badEnv)).toThrow('FATAL_TEST_DATABASE_IS_PRODUCTION');
  });
});
