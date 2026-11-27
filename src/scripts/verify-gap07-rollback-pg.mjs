/**
 * Reproducible PostgreSQL + PostgREST RPC verification for GAP-07 compatible rollback.
 * Requires explicit disposable TEST_DATABASE_URL (never touches production).
 * Optional POSTGREST_URL to verify old named RPC exposure / closed anon privileges.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgres://..." node server/src/scripts/verify-gap07-rollback-pg.mjs
 */
import postgres from 'postgres';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dbUrl = process.env.TEST_DATABASE_URL;
if (!dbUrl) {
  console.log('[verify-gap07-rollback-pg] NOT_RUN: TEST_DATABASE_URL is not set');
  process.exit(0);
}

const sql = postgres(dbUrl, { max: 2 });

try {
  const rollbackSql = readFileSync('server/src/db/migrations/app_rollback_060_074_preserve_data.sql', 'utf8');
  await sql.unsafe(rollbackSql);

  const [{ is_enabled: outboxEnabled }] = await sql`SELECT is_enabled FROM public.crm_outbox_settings WHERE id = 1`;
  assert.equal(outboxEnabled, false, 'Outbox worker must be disabled after app rollback');

  const [{ priv }] = await sql`
    SELECT has_function_privilege('anon', 'public.fn_assign_lead_atomic(bigint,bigint,bigint,text,int,boolean,int)', 'EXECUTE') AS priv
  `;
  assert.equal(priv, false, 'anon must NOT have EXECUTE on fn_assign_lead_atomic');

  if (process.env.POSTGREST_URL) {
    const resp = await fetch(`${process.env.POSTGREST_URL}/rpc/fn_assign_lead_atomic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.ok([401, 403, 404].includes(resp.status), `PostgREST anon RPC call must be blocked, got ${resp.status}`);
  } else {
    console.log('[verify-gap07-rollback-pg] PostgREST RPC HTTP check NOT_RUN: POSTGREST_URL is not set');
  }

  console.log('[verify-gap07-rollback-pg] PASS');
} finally {
  await sql.end();
}
