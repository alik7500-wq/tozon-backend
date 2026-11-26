/**
 * Reproducible 2-process PostgreSQL concurrency test for GAP-01 / GAP-01.1:
 *   1. Cross-project last-slot race (fn_select_and_assign_lead_atomic)
 *   2. Simultaneous manual (fn_assign_lead_atomic) vs auto (fn_select_and_assign_lead_atomic)
 *   3. Two concurrent pool workers (fn_run_lead_pool_batch advisory lock)
 *
 * Runs ONLY against an explicit TEST_DATABASE_URL or STAGING_DATABASE_URL.
 * Usage:
 *   TEST_DATABASE_URL="postgres://..." node server/src/scripts/verify-gap01-two-process-pg.mjs
 */
import postgres from 'postgres';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dbUrl = process.env.TEST_DATABASE_URL || process.env.STAGING_DATABASE_URL;
if (!dbUrl) {
  console.log('[verify-gap01-two-process] NOT_RUN: TEST_DATABASE_URL / STAGING_DATABASE_URL is not set');
  process.exit(0);
}

const sql = postgres(dbUrl, { max: 2 });

async function runChildCommand(mode, arg, startAtMs) {
  const selfPath = fileURLToPath(import.meta.url);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [selfPath, '--child', mode, String(arg), String(startAtMs)], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Child ${mode} exited ${code}: ${err || out}`));
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()));
      } catch (e) {
        reject(new Error(`Invalid child output: ${out} (${e.message})`));
      }
    });
  });
}

if (process.argv.includes('--child')) {
  const idx = process.argv.indexOf('--child');
  const mode = process.argv[idx + 1];
  const arg = Number(process.argv[idx + 2]);
  const startAtMs = Number(process.argv[idx + 3]);
  const waitMs = startAtMs - Date.now();
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

  let res;
  if (mode === 'auto') {
    res = (await sql`SELECT public.fn_select_and_assign_lead_atomic(${arg}, NULL, NULL, 'TWO_PROC_AUTO', NOW()) AS r`)[0].r;
  } else if (mode === 'manual') {
    res = (await sql`SELECT public.fn_assign_lead_atomic(${arg}, ${Number(process.env.SYNTH_REP_ID)}, NULL, 'TWO_PROC_MANUAL', 1, true, 1) AS r`)[0].r;
  } else if (mode === 'pool') {
    res = (await sql`SELECT public.fn_run_lead_pool_batch(25, true, NOW()) AS r`)[0].r;
  }
  console.log(JSON.stringify(res));
  await sql.end();
  process.exit(0);
}

const tag = `gap01_2proc_${Date.now()}`;
const created = { projectIds: [], userIds: [], leadIds: [], settingsIds: [] };

try {
  // Setup isolated synthetic data
  const [p1] = await sql`INSERT INTO public.projects (name) VALUES (${tag + '_p1'}) RETURNING id`;
  const [p2] = await sql`INSERT INTO public.projects (name) VALUES (${tag + '_p2'}) RETURNING id`;
  created.projectIds.push(p1.id, p2.id);

  const [rep] = await sql`
    INSERT INTO public.users (name, email, role, is_active, is_sales_rep, all_projects_access)
    VALUES (${tag + '_rep'}, ${tag + '@test.local'}, 'SALES_MANAGER', 1, true, true)
    RETURNING id
  `;
  created.userIds.push(rep.id);
  process.env.SYNTH_REP_ID = String(rep.id);

  const [s1] = await sql`
    INSERT INTO public.lead_distribution_settings (project_id, enabled, algorithm, max_open_leads_per_rep, working_hours_only)
    VALUES (${p1.id}, true, 'LEAST_LOADED', 1, false)
    RETURNING id
  `;
  const [s2] = await sql`
    INSERT INTO public.lead_distribution_settings (project_id, enabled, algorithm, max_open_leads_per_rep, working_hours_only)
    VALUES (${p2.id}, true, 'LEAST_LOADED', 1, false)
    RETURNING id
  `;
  created.settingsIds.push(s1.id, s2.id);

  const [l1] = await sql`INSERT INTO public.leads (full_name, status, stage, interested_project_id) VALUES (${tag + '_l1'}, 'NEW', 'NEW', ${p1.id}) RETURNING id`;
  const [l2] = await sql`INSERT INTO public.leads (full_name, status, stage, interested_project_id) VALUES (${tag + '_l2'}, 'NEW', 'NEW', ${p2.id}) RETURNING id`;
  const [lRace] = await sql`INSERT INTO public.leads (full_name, status, stage, interested_project_id) VALUES (${tag + '_lrace'}, 'NEW', 'NEW', ${p1.id}) RETURNING id`;
  created.leadIds.push(l1.id, l2.id, lRace.id);

  // 1. Cross-project last-slot race
  const barrier1 = Date.now() + 400;
  const [r1, r2] = await Promise.all([
    runChildCommand('auto', l1.id, barrier1),
    runChildCommand('auto', l2.id, barrier1)
  ]);
  const assignedCross = [r1, r2].filter((r) => r.status === 'ASSIGNED');
  const pooledCross = [r1, r2].filter((r) => r.status === 'POOLED');
  assert.equal(assignedCross.length, 1, 'Cross-project race must assign at most 1 lead');
  assert.equal(pooledCross.length, 1, 'Cross-project race must pool the 2nd lead');

  // 2. Manual vs Auto race on same lead
  const barrier2 = Date.now() + 400;
  const [rMan, rAuto] = await Promise.all([
    runChildCommand('manual', lRace.id, barrier2),
    runChildCommand('auto', lRace.id, barrier2)
  ]);
  assert.ok(rMan.success || rAuto.success, 'At least one winner expected in manual vs auto race');

  // 3. Two concurrent pool workers
  const barrier3 = Date.now() + 400;
  const [pw1, pw2] = await Promise.all([
    runChildCommand('pool', 0, barrier3),
    runChildCommand('pool', 0, barrier3)
  ]);
  const lockedCount = [pw1, pw2].filter((r) => r.reason === 'POOL_WORKER_LOCKED').length;
  assert.equal(lockedCount, 1, 'Exactly one pool worker must acquire advisory lock');

  console.log('[verify-gap01-two-process] PASS: all 2-process PostgreSQL assertions succeeded');
} finally {
  if (created.leadIds.length) {
    await sql`DELETE FROM public.crm_event_outbox WHERE aggregate_id = ANY(${created.leadIds.map(String)})`;
    await sql`DELETE FROM public.lead_assignment_history WHERE lead_id = ANY(${created.leadIds})`;
    await sql`DELETE FROM public.leads WHERE id = ANY(${created.leadIds})`;
  }
  if (created.settingsIds.length) {
    await sql`DELETE FROM public.lead_distribution_settings WHERE id = ANY(${created.settingsIds})`;
  }
  if (created.userIds.length) {
    await sql`DELETE FROM public.users WHERE id = ANY(${created.userIds})`;
  }
  if (created.projectIds.length) {
    await sql`DELETE FROM public.projects WHERE id = ANY(${created.projectIds})`;
  }
  await sql.end();
}
