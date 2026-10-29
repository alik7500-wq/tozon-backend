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
  let normalized;
  let username;
  try {
    normalized = decodeURIComponent(rawUrl).toLowerCase();
    username = decodeURIComponent(parsed.username);
  } catch { throw new Error('INVALID_COMMERCIAL_DATABASE_URL_ENCODING'); }
  for (const ref of PROTECTED_REFS) {
    if (normalized.includes(ref)) throw new Error('PRODUCTION_DATABASE_TARGET_FORBIDDEN');
  }
  // Bind the ref to the routing fields, never to a password, path or query.
  const direct = parsed.hostname === `db.${projectRef}.supabase.co`
    && ['postgres', `postgres.${projectRef}`].includes(username);
  const pooler = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(parsed.hostname)
    && username === `postgres.${projectRef}`;
  if (!direct && !pooler) {
    throw new Error('DATABASE_PROJECT_REF_MISMATCH');
  }
  if ((parsed.port && parsed.port !== '5432') || parsed.pathname !== '/postgres'
    || parsed.search || parsed.hash) {
    throw new Error('UNSUPPORTED_COMMERCIAL_DATABASE_CONNECTION');
  }
  return { projectRef, databaseUrl: rawUrl };
}
