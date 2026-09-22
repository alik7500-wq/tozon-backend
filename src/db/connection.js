import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY in environment variables.');
  process.exit(1);
}

const PRODUCTION_PROJECT_REF = 'yeslzrrcwgcqfxhgbrqk';

export const assertSafeTestDatabase = (customEnv = process.env) => {
  const nodeEnv = customEnv.NODE_ENV;
  if (nodeEnv !== 'test') {
    return true;
  }

  // Collect all possible database connection sources
  const sources = [
    customEnv.TEST_DATABASE_URL,
    customEnv.TEST_SUPABASE_URL,
    customEnv.DATABASE_URL,
    customEnv.SUPABASE_URL,
    customEnv.SUPABASE_SERVICE_ROLE_KEY,
    customEnv.PGHOST,
  ].filter(Boolean);

  // 1. Check for Production project ref or production host in ANY connection string
  for (const src of sources) {
    if (src.includes(PRODUCTION_PROJECT_REF) || src.includes('yeslzrrcwgcqfxhgbrqk.supabase.co')) {
      throw new Error('FATAL_TEST_DATABASE_IS_PRODUCTION');
    }
  }

  // 2. Strict requirement: NODE_ENV=test MUST specify dedicated TEST_DATABASE_URL or TEST_SUPABASE_URL
  const testConfig = customEnv.TEST_DATABASE_URL || customEnv.TEST_SUPABASE_URL;
  if (!testConfig) {
    throw new Error('TEST_DATABASE_CONFIGURATION_REQUIRED');
  }

  return true;
};

let db;
let serviceDb;

export const connectDB = () => {
  if (db) return db;

  // Enforce test database safety guard
  assertSafeTestDatabase();

  const activeUrl = process.env.NODE_ENV === 'test'
    ? (process.env.TEST_SUPABASE_URL || process.env.TEST_DATABASE_URL)
    : supabaseUrl;

  const activeKey = process.env.NODE_ENV === 'test'
    ? (process.env.TEST_SUPABASE_KEY || supabaseKey)
    : supabaseKey;

  db = createClient(activeUrl, activeKey);
  console.log('Connected to Supabase');
  
  return db;
};

export const getDB = () => {
  if (!db) {
    throw new Error('Database not initialized. Call connectDB first.');
  }
  return db;
};

export const getServiceDB = () => {
  if (serviceDb) return serviceDb;

  assertSafeTestDatabase();

  const rawKey = process.env.NODE_ENV === 'test'
    ? (process.env.TEST_SUPABASE_SERVICE_ROLE_KEY || process.env.TEST_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)
    : process.env.SUPABASE_SERVICE_ROLE_KEY;

  const serviceRoleKey = rawKey ? rawKey.trim() : null;

  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY_REQUIRED: SUPABASE_SERVICE_ROLE_KEY is required for server-only operations');
  }

  const activeUrl = process.env.NODE_ENV === 'test'
    ? (process.env.TEST_SUPABASE_URL || process.env.TEST_DATABASE_URL || supabaseUrl)
    : supabaseUrl;

  serviceDb = createClient(activeUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
  return serviceDb;
};

