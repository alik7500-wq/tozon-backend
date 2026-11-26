/**
 * Reproducible 2-process PostgreSQL concurrency test for GAP-01 / GAP-01.2:
 *   1. Cross-project last-slot race (fn_select_and_assign_lead_atomic)
 *   2. Simultaneous manual (fn_assign_lead_atomic) vs auto (fn_select_and_assign_lead_atomic)
 *   3. Guaranteed overlapping advisory lock between two pool worker transactions
 *   4. Pool batch + concurrent fn_select_and_assign_lead_atomic without lock inversion / deadlock
 *
 * Requires an isolated disposable test PostgreSQL DB via TEST_DATABASE_URL.
 * Usage:
 *   TEST_DATABASE_URL="postgres://..." node server/src/scripts/verify-gap01-two-process-pg.mjs
 */
import postgres from 'postgres';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dbUrl = process.env.TEST_DATABASE_URL;
if (!dbUrl) {
  console.log('[verify-gap01-two-process] NOT_RUN: TEST_DATABASE_URL is not set (requires isolated disposable test PostgreSQL)');
  process.exit(0);
}

const sql = postgres(dbUrl, { max: 2 });

function spawnSyncedChild(mode, payload) {
  const selfPath = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [selfPath, '--child', mode, JSON.stringify(payload)], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });

  const readyPromise = new Promise((resolve, reject) => {
    child.once('message', (msg) => {
      if (msg?.ready) resolve();
      else reject(new Error(`Unexpected child handshake: ${JSON.stringify(msg)}`));
    });
    child.once('error', reject);
  });

  const donePromise = new Promise((resolve, reject) => {
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Child ${mode} exited ${code}: ${err || out}`));
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()));
      } catch (e) {
        reject(new Error(`Invalid child output: ${out} (${e.message})`));
      }
    });
  });

  return { child, readyPromise, donePromise, go: () => child.send({ go: true }) };
}

if (process.argv.includes('--child')) {
  const idx = process.argv.indexOf('--child');
  const mode = process.argv[idx + 1];
  const payload = JSON.parse(process.argv[idx + 2]);

  // Warm up connection before signaling readiness
  await sql`SELECT 1`;
  process.send({ ready: true });
  await new Promise((resolve) => process.once('message', (m) => { if (m?.go) resolve(); }));

  let res;
  if (mode === 'auto') {
    res = (await sql`SELECT public.fn_select_and_assign_lead_atomic(${payload.leadId}, NULL, ${payload.expectedVersion ?? null}, 'TWO_PROC_AUTO', NOW()) AS r`)[0].r;
  } else if (mode === 'manual') {
    res = (await sql`SELECT public.fn_assign_lead_atomic(${payload.leadId}, ${payload.repId}, NULL, 'TWO_PROC_MANUAL', 25, true, ${payload.expectedVersion ?? 1}) AS r`)[0].r;
  } else if (mode === 'pool') {
    res = (await sql`SELECT public.fn_run_lead_pool_batch(25, true, NOW()) AS r`)[0].r;
  } else if (mode === 'hold_advisory') {
    await sql.begin(async (tx) => {
      const [{ locked }] = await tx`SELECT pg_try_advisory_xact_lock(746968) AS locked`;
      process.send({ locked });
      await new Promise((resolve) => process.once('message', (m) => { if (m?.release) resolve(); }));
    });
    res = { released: true };
  } else if (mode === 'hold_lead_then_assign') {
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM public.leads WHERE id = ${payload.leadId} FOR UPDATE`;
      process.send({ leadLocked: true });
      await new Promise((resolve) => process.once('message', (m) => { if (m?.proceed) resolve(); }));
      res = (await tx`SELECT public.fn_select_and_assign_lead_atomic(${payload.leadId}, NULL, NULL, 'CONCURRENT_HOLD', NOW()) AS r`)[0].r;
    });
  }
  console.log(JSON.stringify(res));
  await sql.end();
  process.exit(0);
}

const tag = `gap01_2proc_${Date.now()}`;
const created = { projectIds: [], userIds: [], leadIds: [], settingsIds: [] };

try {
  // Precondition: ensure no unrelated unassigned leads exist that fn_run_lead_pool_batch could touch
  const [{ c: preUnassigned }] = await sql`
    SELECT COUNT(*)::int AS c FROM public.leads WHERE responsible_user_id IS NULL AND archived_at IS NULL
  `;
  assert.equal(preUnassigned, 0, 'Disposable TEST_DATABASE_URL must have 0 pre-existing unassigned leads');

  // Setup isolated synthetic data
  const [p1] = await sql`INSERT INTO public.projects (name) VALUES (${tag + '_p1'}) RETURNING id`;
  const [p2] = await sql`INSERT INTO public.projects (name) VALUES (${tag + '_p2'}) RETURNING id`;
  created.projectIds.push(p1.id, p2.id);

  const [rep] = await sql`
    INSERT INTO public.users (name, email, role, is_active, is_sales_rep, all_projects_access)
    VALUES (${tag + '_rep1'}, ${tag + '_1@test.local'}, 'SALES_MANAGER', 1, true, true)
    RETURNING id
  `;
  const [rep2] = await sql`
    INSERT INTO public.users (name, email, role, is_active, is_sales_rep, all_projects_access)
    VALUES (${tag + '_rep2'}, ${tag + '_2@test.local'}, 'SALES_MANAGER', 1, true, true)
    RETURNING id
  `;
  created.userIds.push(rep.id, rep2.id);

  // Restrict project settings strictly to synthetic rep (capacity 1)
  const [s1] = await sql`
    INSERT INTO public.lead_distribution_settings (project_id, enabled, algorithm, max_open_leads_per_rep, allowed_user_ids, working_hours_only)
    VALUES (${p1.id}, true, 'LEAST_LOADED', 1, ${JSON.stringify([rep.id])}::jsonb, false)
    RETURNING id
  `;
  const [s2] = await sql`
    INSERT INTO public.lead_distribution_settings (project_id, enabled, algorithm, max_open_leads_per_rep, allowed_user_ids, working_hours_only)
    VALUES (${p2.id}, true, 'LEAST_LOADED', 1, ${JSON.stringify([rep.id])}::jsonb, false)
    RETURNING id
  `;
  created.settingsIds.push(s1.id, s2.id);

  const [l1] = await sql`INSERT INTO public.leads (full_name, status, stage, interested_project_id) VALUES (${tag + '_l1'}, 'NEW', 'NEW', ${p1.id}) RETURNING id`;
  const [l2] = await sql`INSERT INTO public.leads (full_name, status, stage, interested_project_id) VALUES (${tag + '_l2'}, 'NEW', 'NEW', ${p2.id}) RETURNING id`;
  created.leadIds.push(l1.id, l2.id);

  // 1. Cross-project last-slot race with real readiness barrier
  const c1 = spawnSyncedChild('auto', { leadId: l1.id });
  const c2 = spawnSyncedChild('auto', { leadId: l2.id });
  await Promise.all([c1.readyPromise, c2.readyPromise]);
  c1.go();
  c2.go();
  const [r1, r2] = await Promise.all([c1.donePromise, c2.donePromise]);
  assert.equal([r1, r2].filter((r) => r.status === 'ASSIGNED').length, 1, 'Cross-project race must assign exactly 1 lead');
  assert.equal([r1, r2].filter((r) => r.status === 'POOLED').length, 1, 'Cross-project race must pool the 2nd lead');

  const crossLeads = await sql`SELECT id, responsible_user_id, version FROM public.leads WHERE id = ANY(${[l1.id, l2.id]})`;
  assert.equal(crossLeads.filter((l) => l.responsible_user_id === rep.id && l.version === 2).length, 1);
  assert.equal(crossLeads.filter((l) => l.responsible_user_id === null && l.version === 1).length, 1);
  const [{ c: crossHist }] = await sql`SELECT COUNT(*)::int AS c FROM public.lead_assignment_history WHERE lead_id = ANY(${[l1.id, l2.id]})`;
  assert.equal(crossHist, 1);
  const [{ c: crossOutbox }] = await sql`SELECT COUNT(*)::int AS c FROM public.crm_event_outbox WHERE aggregate_id = ANY(${[String(l1.id), String(l2.id)]}) AND event_type = 'LEAD_ASSIGNED'`;
  assert.equal(crossOutbox, 1);

  // 2. Manual vs Auto race with exact winner/conflict assertions (allow rep2 on p1)
  await sql`UPDATE public.lead_distribution_settings SET allowed_user_ids = ${JSON.stringify([rep2.id])}::jsonb, max_open_leads_per_rep = 10 WHERE id = ${s1.id}`;
  const [lRace] = await sql`INSERT INTO public.leads (full_name, status, stage, interested_project_id) VALUES (${tag + '_lrace'}, 'NEW', 'NEW', ${p1.id}) RETURNING id`;
  created.leadIds.push(lRace.id);

  const cm = spawnSyncedChild('manual', { leadId: lRace.id, repId: rep2.id, expectedVersion: 1 });
  const ca = spawnSyncedChild('auto', { leadId: lRace.id, expectedVersion: 1 });
  await Promise.all([cm.readyPromise, ca.readyPromise]);
  cm.go();
  ca.go();
  const [rMan, rAuto] = await Promise.all([cm.donePromise, ca.donePromise]);
  const winners = [rMan, rAuto].filter((r) => r.success === true && r.status === 'ASSIGNED');
  const conflicts = [rMan, rAuto].filter((r) => r.success === false && r.error_code === 'VERSION_CONFLICT');
  assert.equal(winners.length, 1, 'Manual vs Auto must have exactly 1 winner');
  assert.equal(conflicts.length, 1, 'Manual vs Auto must return VERSION_CONFLICT to the loser');
  const [raceRow] = await sql`SELECT responsible_user_id, version FROM public.leads WHERE id = ${lRace.id}`;
  assert.equal(raceRow.version, 2);
  assert.equal(raceRow.responsible_user_id, rep2.id);
  const [{ c: raceHist }] = await sql`SELECT COUNT(*)::int AS c FROM public.lead_assignment_history WHERE lead_id = ${lRace.id}`;
  assert.equal(raceHist, 1);

  // 3. Guaranteed overlapping advisory lock between two pool worker transactions
  const holder = spawnSyncedChild('hold_advisory', {});
  await holder.readyPromise;
  holder.go();
  await new Promise((resolve, reject) => {
    holder.child.once('message', (m) => (m?.locked ? resolve() : reject(new Error('Advisory lock not acquired'))));
  });
  const blockedPool = (await sql`SELECT public.fn_run_lead_pool_batch(25, true, NOW()) AS r`)[0].r;
  assert.equal(blockedPool.skipped, true);
  assert.equal(blockedPool.reason, 'POOL_WORKER_LOCKED');
  holder.child.send({ release: true });
  await holder.donePromise;

  // 4. Pool batch + concurrent fn_select_and_assign_lead_atomic holding next lead (no deadlock, no duplicates)
  const [lp1] = await sql`INSERT INTO public.leads (full_name, status, stage, interested_project_id) VALUES (${tag + '_lp1'}, 'NEW', 'NEW', ${p1.id}) RETURNING id`;
  const [lp2] = await sql`INSERT INTO public.leads (full_name, status, stage, interested_project_id) VALUES (${tag + '_lp2'}, 'NEW', 'NEW', ${p1.id}) RETURNING id`;
  created.leadIds.push(lp1.id, lp2.id);

  const p2Holder = spawnSyncedChild('hold_lead_then_assign', { leadId: lp2.id });
  await p2Holder.readyPromise;
  p2Holder.go();
  await new Promise((resolve, reject) => {
    p2Holder.child.once('message', (m) => (m?.leadLocked ? resolve() : reject(new Error('Lead 2 lock not acquired'))));
  });

  const poolProc = spawnSyncedChild('pool', {});
  await poolProc.readyPromise;
  poolProc.go();
  const poolRes = await poolProc.donePromise;
  p2Holder.child.send({ proceed: true });
  const holdAssignRes = await p2Holder.donePromise;

  assert.equal(poolRes.errors, 0);
  assert.equal(holdAssignRes.status, 'ASSIGNED');
  const finalPoolLeads = await sql`SELECT id, responsible_user_id, version FROM public.leads WHERE id = ANY(${[lp1.id, lp2.id]})`;
  assert.ok(finalPoolLeads.every((l) => l.responsible_user_id !== null && l.version === 2));

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
