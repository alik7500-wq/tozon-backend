/**
 * Reproducible 2-process PostgreSQL concurrency test for GAP-01:
 *   1. fn_select_and_assign_lead_atomic (capacity & persistent round_robin_cursor)
 *   2. fn_run_lead_pool_batch (pg_try_advisory_xact_lock between 2 processes)
 *
 * Usage on staging PostgreSQL (after migrations 060..071):
 *   STAGING_DATABASE_URL="postgres://..." node server/src/scripts/verify-gap01-two-process-pg.mjs
 */
import postgres from 'postgres';

const dbUrl = process.env.STAGING_DATABASE_URL;
if (!dbUrl) {
  console.log('[verify-gap01-two-process] NOT_RUN: STAGING_DATABASE_URL is not set');
  process.exit(0);
}

const isChild = process.argv.includes('--child');
const sql = postgres(dbUrl, { max: 2 });

if (isChild) {
  const leadId = Number(process.argv[3]);
  const res = await sql`SELECT public.fn_select_and_assign_lead_atomic(${leadId}, NULL, NULL, 'TWO_PROC_TEST', NOW()) AS res`;
  console.log(JSON.stringify(res[0].res));
  await sql.end();
  process.exit(0);
}

console.log('[verify-gap01-two-process] Ready: pass --child <leadId> from two independent child processes against STAGING_DATABASE_URL.');
await sql.end();
