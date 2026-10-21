// Commercial installer safety guard. No database connection is opened here.
const PROTECTED_REFS = new Set([
  'yeslzrrcwgcqfxhgbrqk', // TOZON production
  'xzvtjcqwmuezxyeerkki', // POPUTKI production
]);

export function assertCommercialInstallTarget(env = process.env) {
  if (env.COMMERCIAL_INSTALL_CONFIRM !== 'ISOLATED_TEST_DATABASE') {
    throw new Error('COMMERCIAL_INSTALL_CONFIRM_REQUIRED');
  }
  const projectRef = String(env.COMMERCIAL_SUPABASE_PROJECT_REF || '').trim().toLowerCase();
  if (!/^[a-z0-9]{20}$/.test(projectRef) || PROTECTED_REFS.has(projectRef)) {
    throw new Error('INVALID_OR_PROTECTED_COMMERCIAL_PROJECT_REF');
  }
  const rawUrl = env.COMMERCIAL_DATABASE_URL;
  if (!rawUrl) throw new Error('COMMERCIAL_DATABASE_URL_REQUIRED');
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error('INVALID_COMMERCIAL_DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('COMMERCIAL_DATABASE_MUST_BE_POSTGRESQL');
  }
  if (!parsed.hostname || !parsed.username || !parsed.password) {
    throw new Error('COMMERCIAL_DATABASE_CREDENTIALS_REQUIRED');
  }
  const normalized = decodeURIComponent(rawUrl).toLowerCase();
  for (const ref of PROTECTED_REFS) {
    if (normalized.includes(ref)) throw new Error('PRODUCTION_DATABASE_TARGET_FORBIDDEN');
  }
  if (!normalized.includes(projectRef)) {
    throw new Error('DATABASE_PROJECT_REF_MISMATCH');
  }
  return { projectRef, databaseUrl: rawUrl };
}
