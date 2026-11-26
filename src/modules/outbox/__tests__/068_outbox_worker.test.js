import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const state = { db: null };

function createPgliteSupabaseAdapter() {
  return {
    from(table) {
      const filters = [];
      let inFilter = null;
      let orderCol = null;
      let orderAsc = true;
      let limitVal = null;

      const builder = {
        select() { return builder; },
        eq(col, val) { filters.push({ col, val }); return builder; },
        in(col, vals) { inFilter = { col, vals }; return builder; },
        order(col, opts = {}) { orderCol = col; orderAsc = opts.ascending !== false; return builder; },
        limit(n) { limitVal = n; return builder; },
        async _exec() {
          const clauses = [];
          const params = [];
          filters.forEach((f, idx) => {
            clauses.push(`${f.col} = $${idx + 1}`);
            params.push(f.val);
          });
          if (inFilter) {
            const placeholders = inFilter.vals.map((_, i) => `$${params.length + i + 1}`);
            clauses.push(`${inFilter.col} IN (${placeholders.join(', ')})`);
            params.push(...inFilter.vals);
          }
          const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
          const orderSql = orderCol ? `ORDER BY ${orderCol} ${orderAsc ? 'ASC' : 'DESC'}` : '';
          const limitSql = limitVal ? `LIMIT ${Number(limitVal)}` : '';
          const res = await state.db.query(`SELECT * FROM public.${table} ${whereSql} ${orderSql} ${limitSql}`, params);
          return { data: res.rows, error: null };
        },
        async single() {
          const { data, error } = await builder._exec();
          if (error) return { data: null, error };
          if (!data || data.length === 0) return { data: null, error: { code: 'PGRST116', message: 'No rows' } };
          return { data: data[0], error: null };
        },
        async maybeSingle() {
          const { data, error } = await builder._exec();
          if (error) return { data: null, error };
          return { data: data?.[0] || null, error: null };
        },
        insert(rows) {
          return {
            select() {
              return {
                async single() {
                  const row = rows[0];
                  const cols = Object.keys(row);
                  const vals = Object.values(row);
                  const placeholders = cols.map((_, i) => `$${i + 1}`);
                  try {
                    const res = await state.db.query(
                      `INSERT INTO public.${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
                      vals
                    );
                    return { data: res.rows[0], error: null };
                  } catch (e) {
                    return { data: null, error: { code: e.code, message: e.message } };
                  }
                }
              };
            }
          };
        },
        async upsert(rows, opts = {}) {
          for (const row of rows) {
            const cols = Object.keys(row);
            const vals = Object.values(row).map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v));
            const placeholders = cols.map((_, i) => `$${i + 1}`);
            const conflict = opts.onConflict ? `ON CONFLICT (${opts.onConflict}) DO NOTHING` : '';
            await state.db.query(
              `INSERT INTO public.${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ${conflict}`,
              vals
            );
          }
          return { data: rows, error: null };
        },
        update(patch) {
          return {
            eq(col, val) {
              filters.push({ col, val });
              const runUpdate = async () => {
                const sets = [];
                const params = [];
                Object.entries(patch).forEach(([k, v], idx) => {
                  sets.push(`${k} = $${idx + 1}`);
                  params.push(v && typeof v === 'object' ? JSON.stringify(v) : v);
                });
                const clauses = [];
                filters.forEach((f, idx) => {
                  clauses.push(`${f.col} = $${params.length + idx + 1}`);
                  params.push(f.val);
                });
                const res = await state.db.query(
                  `UPDATE public.${table} SET ${sets.join(', ')} WHERE ${clauses.join(' AND ')} RETURNING *`,
                  params
                );
                return { data: res.rows[0] || null, error: null };
              };
              return {
                select() { return { single: runUpdate }; },
                then(resolve, reject) { return runUpdate().then(resolve, reject); }
              };
            }
          };
        },
        then(resolve, reject) { return builder._exec().then(resolve, reject); }
      };
      return builder;
    },
    async rpc(fnName, paramsObj) {
      if (fnName === 'fn_claim_outbox_batch') {
        const res = await state.db.query(
          `SELECT * FROM public.fn_claim_outbox_batch($1, $2, $3, $4)`,
          [paramsObj.p_worker_id, paramsObj.p_batch_size, paramsObj.p_lease_seconds, paramsObj.p_ignore_enabled]
        );
        return { data: res.rows, error: null };
      }
      if (fnName === 'fn_complete_outbox_event') {
        const res = await state.db.query(
          `SELECT public.fn_complete_outbox_event($1, $2, $3, $4, $5) AS res`,
          [paramsObj.p_event_id, paramsObj.p_lease_token, paramsObj.p_outcome, paramsObj.p_error_kind, paramsObj.p_error_message]
        );
        return { data: res.rows[0]?.res || null, error: null };
      }
      if (fnName === 'fn_apply_outbox_effect') {
        try {
          const res = await state.db.query(
            `SELECT public.fn_apply_outbox_effect($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb) AS res`,
            [
              paramsObj.p_event_id,
              paramsObj.p_lease_token,
              paramsObj.p_expected_lead_id,
              paramsObj.p_expected_assigned_user_id,
              paramsObj.p_require_open,
              JSON.stringify(paramsObj.p_tasks || []),
              JSON.stringify(paramsObj.p_notifications || []),
              JSON.stringify(paramsObj.p_rule_executions || [])
            ]
          );
          return { data: res.rows[0]?.res || null, error: null };
        } catch (e) {
          return { data: null, error: { message: e.message } };
        }
      }
      if (fnName === 'fn_test_expire_lease_helper') {
        await state.db.query(`UPDATE public.crm_event_outbox SET lease_expires_at = NOW() - interval '10 seconds' WHERE id = $1`, [paramsObj.p_event_id]);
        return { data: true, error: null };
      }
      return { data: null, error: null };
    }
  };
}

vi.mock('../../../db/connection.js', () => ({
  getDB: () => createPgliteSupabaseAdapter(),
  getServiceDB: () => createPgliteSupabaseAdapter(),
  getSecureDB: () => createPgliteSupabaseAdapter()
}));

import { OutboxWorkerService } from '../outboxWorker.service.js';

describe('R08: Real crm_event_outbox Worker, Lease Recovery, Idempotent Effects, Quarantine & Cutoff', () => {
  beforeAll(async () => {
    const db = new PGlite();
    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

      CREATE TABLE public.users (
        id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'SALES_MANAGER',
        is_active INT NOT NULL DEFAULT 1, is_sales_rep BOOLEAN NOT NULL DEFAULT TRUE
      );
      CREATE TABLE public.projects (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE public.leads (
        id BIGSERIAL PRIMARY KEY, full_name TEXT NOT NULL, phone TEXT, secondary_phone TEXT,
        source TEXT DEFAULT 'DIRECT', status TEXT NOT NULL DEFAULT 'NEW',
        responsible_user_id BIGINT REFERENCES public.users(id), interested_project_id BIGINT REFERENCES public.projects(id),
        budget_min_minor BIGINT, budget_max_minor BIGINT, notes TEXT,
        assigned_at TIMESTAMPTZ, first_contact_at TIMESTAMPTZ, first_contact_by_user_id BIGINT,
        first_contact_outcome VARCHAR(50), reassignment_reason TEXT, lost_reason TEXT,
        idempotency_key VARCHAR(255), created_at TEXT NOT NULL DEFAULT NOW()::TEXT,
        updated_at TEXT NOT NULL DEFAULT NOW()::TEXT, archived_at TEXT
      );
      CREATE TABLE public.deals (
        id BIGSERIAL PRIMARY KEY, lead_id BIGINT NOT NULL REFERENCES public.leads(id),
        unit_id BIGINT NOT NULL, responsible_user_id BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT'
      );
      CREATE TABLE public.tasks (
        id BIGSERIAL PRIMARY KEY, lead_id BIGINT REFERENCES public.leads(id), deal_id BIGINT,
        assigned_user_id BIGINT, created_by BIGINT, type TEXT NOT NULL DEFAULT 'CALL',
        priority TEXT DEFAULT 'NORMAL', title TEXT NOT NULL, description TEXT,
        due_date TEXT, status TEXT NOT NULL DEFAULT 'OPEN', idempotency_key VARCHAR(255)
      );
      CREATE TABLE public.lead_assignment_history (
        id BIGSERIAL PRIMARY KEY, lead_id BIGINT NOT NULL, from_user_id BIGINT, to_user_id BIGINT,
        assigned_by_user_id BIGINT, assignment_type VARCHAR(50) DEFAULT 'MANUAL', reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE public.lead_distribution_settings (
        id BIGSERIAL PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT FALSE, algorithm VARCHAR(50) DEFAULT 'LEAST_LOADED',
        max_open_leads_per_rep INT DEFAULT 25, excluded_user_ids JSONB DEFAULT '[]'::jsonb,
        working_hours_only BOOLEAN DEFAULT TRUE, auto_reassign_on_stagnant BOOLEAN DEFAULT FALSE,
        updated_by_user_id BIGINT, updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await db.exec(readFileSync('src/db/migrations/038_create_user_notifications.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/060_crm_sales_completion_foundation.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/062_atomic_lead_stage_transition.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/063_harden_stage_transition_and_task_cancel.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/066_user_project_access.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/068_outbox_worker_lease_and_controls.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/069_outbox_atomic_effect_guard.sql', 'utf8'));
    state.db = db;
  }, 30000);

  beforeEach(async () => {
    await state.db.exec(`
      TRUNCATE public.crm_automation_executions, public.crm_automation_rules, public.crm_event_outbox,
               public.user_notifications, public.tasks, public.lead_stage_history, public.lead_assignment_history,
               public.user_project_access, public.leads, public.projects, public.users RESTART IDENTITY CASCADE;
      INSERT INTO public.crm_outbox_settings (id, is_enabled, cutoff_at)
      VALUES (1, TRUE, '2020-01-01T00:00:00Z')
      ON CONFLICT (id) DO UPDATE SET is_enabled = TRUE, cutoff_at = '2020-01-01T00:00:00Z';
      INSERT INTO public.projects (id, name) VALUES (1, 'Proj 1'), (2, 'Proj 2');
      INSERT INTO public.users (id, name, role, is_active, is_sales_rep, all_projects_access) VALUES
        (1, 'Admin', 'ADMIN', 1, false, true),
        (2, 'Mgr A', 'SALES_MANAGER', 1, true, false),
        (3, 'Mgr B', 'SALES_MANAGER', 1, true, false),
        (4, 'Inactive Mgr', 'SALES_MANAGER', 0, true, true);
      INSERT INTO public.user_project_access (user_id, project_id, can_view) VALUES (2, 1, true), (3, 2, true);
    `);
  });

  it('respects disabled flag & historical cutoff_at and previews affected counts', async () => {
    await state.db.query(`UPDATE public.crm_outbox_settings SET is_enabled = FALSE, cutoff_at = '2026-11-26T12:00:00Z' WHERE id = 1`);
    await state.db.query(`INSERT INTO public.leads (id, full_name, status, stage, responsible_user_id, interested_project_id) VALUES (1, 'Lead 1', 'NEW', 'NEW', 2, 1)`);
    await state.db.query(`UPDATE public.crm_event_outbox SET created_at = '2026-11-26T10:00:00Z'`);

    const preview = await OutboxWorkerService.previewCutoff({ cutoffAt: '2026-11-26T12:00:00Z' });
    expect(preview.skippedHistoricalCount).toBe(1);
    expect(preview.eligibleCount).toBe(0);

    // Disabled worker claims 0
    const resDisabled = await OutboxWorkerService.runOnce({ workerId: 'w1' });
    expect(resDisabled.claimed).toBe(0);

    // Enabled worker still skips event before cutoff_at
    await OutboxWorkerService.updateSettings({ isEnabled: true, actorUserId: 1 });
    const resCutoff = await OutboxWorkerService.runOnce({ workerId: 'w1' });
    expect(resCutoff.claimed).toBe(0);
  });

  it('executes stage transition + crash-after-effect idempotently without creating duplicate tasks or notifications', async () => {
    await state.db.query(`INSERT INTO public.leads (id, full_name, status, stage, version, responsible_user_id, interested_project_id) VALUES (10, 'Buyer 10', 'NEW', 'NEW', 1, 2, 1)`);
    await state.db.query(`DELETE FROM public.crm_event_outbox`);

    // Trigger atomic stage transition to MEETING_SCHEDULED
    await state.db.query(
      `SELECT public.fn_update_lead_stage_atomic(
        p_lead_id => 10,
        p_target_stage => 'MEETING_SCHEDULED',
        p_actor_user_id => 2,
        p_expected_version => 1,
        p_idempotency_key => 'k_meet_10',
        p_meeting_at => '2026-11-27T15:00:00Z'::timestamptz
      )`
    );

    // First run crashes AFTER creating side-effect before DONE
    const rCrash = await OutboxWorkerService.runOnce({ workerId: 'w1', injectFault: 'AFTER_EFFECT_BEFORE_DONE' });
    expect(rCrash.retried).toBe(1);
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.tasks WHERE lead_id = 10`)).rows[0].c).toBe(1);
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.user_notifications WHERE entity_id = 10`)).rows[0].c).toBe(1);

    // Make retry due immediately and re-run -> completes DONE with ZERO duplicate tasks or notifications!
    await state.db.query(`UPDATE public.crm_event_outbox SET next_retry_at = NOW() - interval '1 second'`);
    const rRetry = await OutboxWorkerService.runOnce({ workerId: 'w2' });
    expect(rRetry.done).toBe(1);
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.tasks WHERE lead_id = 10`)).rows[0].c).toBe(1);
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.user_notifications WHERE entity_id = 10`)).rows[0].c).toBe(1);
  });

  it('prevents two competing workers from claiming the same event, recovers expired lease, and rejects stale worker ack', async () => {
    await state.db.query(`INSERT INTO public.leads (id, full_name, status, stage, responsible_user_id, interested_project_id) VALUES (20, 'Lead 20', 'NEW', 'NEW', 2, 1)`);

    // Worker 1 claims batch
    const claim1 = (await state.db.query(`SELECT * FROM public.fn_claim_outbox_batch('w1', 10, 60, false)`)).rows;
    expect(claim1).toHaveLength(1);
    const staleToken = claim1[0].lease_token;

    // Competing Worker 2 claims at the same time -> gets 0 rows
    const claim2 = (await state.db.query(`SELECT * FROM public.fn_claim_outbox_batch('w2', 10, 60, false)`)).rows;
    expect(claim2).toHaveLength(0);

    // Simulate Worker 1 hang -> lease expires -> Worker 2 recovers expired lease to FAILED (with backoff), then processes once due
    await state.db.query(`UPDATE public.crm_event_outbox SET lease_expires_at = NOW() - interval '10 seconds' WHERE id = $1`, [claim1[0].id]);
    await OutboxWorkerService.runOnce({ workerId: 'w2' });
    await state.db.query(`UPDATE public.crm_event_outbox SET next_retry_at = NOW() - interval '1 second'`);
    const w2Res = await OutboxWorkerService.runOnce({ workerId: 'w2' });
    expect(w2Res.done).toBe(1);

    // Late Worker 1 tries to ack with stale lease_token -> rejected with LEASE_LOST
    const staleAck = (await state.db.query(
      `SELECT public.fn_complete_outbox_event($1, $2, 'FAILED', 'TRANSIENT', 'late') AS res`,
      [claim1[0].id, staleToken]
    )).rows[0].res;
    expect(staleAck.ok).toBe(false);
    expect(staleAck.code).toBe('LEASE_LOST');
  });

  it('quarantines unknown/invalid events without blocking valid events and supports controlled replay', async () => {
    await state.db.query(`INSERT INTO public.leads (id, full_name, status, stage, responsible_user_id, interested_project_id) VALUES (30, 'Lead 30', 'NEW', 'NEW', 2, 1)`);
    await state.db.query(`INSERT INTO public.crm_event_outbox (event_type, aggregate_type, aggregate_id, idempotency_key, payload_json) VALUES ('UNKNOWN_FUTURE_EVT', 'lead', '30', 'k_unk_1', '{}'::jsonb)`);

    const res = await OutboxWorkerService.runOnce({ workerId: 'w1' });
    expect(res.quarantined).toBe(1);
    expect(res.done).toBe(1); // Valid LEAD_CREATED still succeeded!

    const diag = await OutboxWorkerService.getDiagnostics();
    expect(diag.quarantinedCount).toBe(1);

    const unkId = diag.recentQuarantined[0].id;
    const replayed = await OutboxWorkerService.replayQuarantined({ eventId: unkId, actorUserId: 1 });
    expect(replayed.status).toBe('PENDING');
    expect(replayed.replayed_by).toBe(1);
  });

  it('enforces project isolation, lead reassignment/close checks, and active user check before applying effects', async () => {
    // Mgr A (id=2) only has Project 1; Lead 40 is in Project 2 (forbidden!)
    await state.db.query(`INSERT INTO public.leads (id, full_name, status, stage, responsible_user_id, interested_project_id) VALUES (40, 'Cross Proj', 'NEW', 'NEW', 2, 2)`);
    // Lead 41 is in Project 1 for Mgr A, but closed as LOST before worker runs
    await state.db.query(`INSERT INTO public.leads (id, full_name, status, stage, responsible_user_id, interested_project_id) VALUES (41, 'Closed Lead', 'NEW', 'NEW', 2, 1)`);
    await state.db.query(`UPDATE public.leads SET status = 'LOST', stage = 'LOST' WHERE id = 41`);

    const res = await OutboxWorkerService.runOnce({ workerId: 'w1' });
    expect(res.done).toBe(2);
    // Neither forbidden project nor closed lead should receive a notification!
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.user_notifications`)).rows[0].c).toBe(0);
  });

  it('R08.1: creates 1 mandatory PRIMARY_FIRST_CONTACT task across LEAD_CREATED + LEAD_ASSIGNED even with rules disabled, and handles NO_ANSWER follow-up', async () => {
    await state.db.query(`INSERT INTO public.leads (id, full_name, status, stage, responsible_user_id, interested_project_id) VALUES (50, 'New 50', 'NEW', 'NEW', 2, 1)`);
    await state.db.query(`INSERT INTO public.lead_assignment_history (lead_id, from_user_id, to_user_id, assigned_by_user_id, assignment_type) VALUES (50, NULL, 2, 1, 'MANUAL')`);
    await state.db.query(`INSERT INTO public.lead_communications (lead_id, actor_user_id, channel, direction, event_type, outcome, project_id) VALUES (50, 2, 'CALL', 'OUTBOUND', 'NO_ANSWER', 'NO_ANSWER', 1)`);

    const res = await OutboxWorkerService.runOnce({ workerId: 'w1' });
    expect(res.done).toBe(3);

    const primaryTasks = (await state.db.query(`SELECT * FROM public.tasks WHERE lead_id = 50 AND rule_key = 'PRIMARY_FIRST_CONTACT'`)).rows;
    expect(primaryTasks).toHaveLength(1);
    const noAnswerTasks = (await state.db.query(`SELECT * FROM public.tasks WHERE lead_id = 50 AND rule_key = 'COMM_NO_ANSWER_FOLLOWUP'`)).rows;
    expect(noAnswerTasks).toHaveLength(1);
  });

  it('R08.1: skips mismatched source/condition rules (not EXECUTED), quarantines unsupported actions, and skips historical imports', async () => {
    await state.db.query(`INSERT INTO public.crm_automation_rules (id, name, source_code, event_type, conditions_json, action_type, is_enabled) VALUES
      (1, 'Insta Only', 'INSTAGRAM', 'LEAD_CREATED', '{}'::jsonb, 'CREATE_TASK', true),
      (2, 'Unsupported SMS', NULL, 'LEAD_ASSIGNED', '{}'::jsonb, 'SEND_EXTERNAL_SMS', true)`);

    // Lead 60 has source DIRECT (mismatch with INSTAGRAM rule 1), plus historical Lead 61
    await state.db.query(`INSERT INTO public.leads (id, full_name, source, status, stage, responsible_user_id, interested_project_id) VALUES (60, 'Direct 60', 'DIRECT', 'NEW', 'NEW', 2, 1)`);
    await state.db.query(`INSERT INTO public.leads (id, full_name, source, status, stage, responsible_user_id, interested_project_id, is_historical_import) VALUES (61, 'Hist 61', 'DIRECT', 'NEW', 'NEW', 2, 1, true)`);

    const r1 = await OutboxWorkerService.runOnce({ workerId: 'w1' });
    expect(r1.done).toBe(2);

    // Rule 1 must be SKIPPED (not EXECUTED!)
    const exec1 = (await state.db.query(`SELECT status, error_message FROM public.crm_automation_executions WHERE rule_id = 1`)).rows;
    expect(exec1).toHaveLength(1);
    expect(exec1[0].status).toBe('SKIPPED');
    expect(exec1[0].error_message).toBe('SOURCE_MISMATCH');

    // Historical Lead 61 must have 0 tasks and 0 notifications
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.tasks WHERE lead_id = 61`)).rows[0].c).toBe(0);
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.user_notifications WHERE entity_id = 61`)).rows[0].c).toBe(0);

    // Unsupported action on LEAD_ASSIGNED -> quarantined, NEVER marked EXECUTED
    await state.db.query(`INSERT INTO public.lead_assignment_history (lead_id, to_user_id, assigned_by_user_id) VALUES (60, 2, 1)`);
    const r2 = await OutboxWorkerService.runOnce({ workerId: 'w1' });
    expect(r2.quarantined).toBe(1);
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.crm_automation_executions WHERE rule_id = 2 AND status = 'EXECUTED'`)).rows[0].c).toBe(0);
  });

  it('R08.1: blocks effect write when lease expired before apply, blocks tasks on SIGNED deal despite stale stage, and rolls back on execution log failure', async () => {
    // 1. Lease expired right before fn_apply_outbox_effect -> 0 tasks/notifications created!
    await state.db.query(`INSERT INTO public.leads (id, full_name, status, stage, responsible_user_id, interested_project_id) VALUES (70, 'Lease Lost 70', 'NEW', 'NEW', 2, 1)`);
    const rLease = await OutboxWorkerService.runOnce({ workerId: 'w1', injectFault: 'EXPIRE_LEASE_BEFORE_APPLY' });
    expect(rLease.leaseLost).toBe(1);
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.tasks WHERE lead_id = 70`)).rows[0].c).toBe(0);

    // 2. Lead 71 has stale stage='NEGOTIATION' but authoritative SIGNED deal -> 0 open-sales tasks!
    await state.db.query(`INSERT INTO public.leads (id, full_name, status, stage, responsible_user_id, interested_project_id) VALUES (71, 'Signed 71', 'NEGOTIATION', 'NEGOTIATION', 2, 1)`);
    await state.db.query(`INSERT INTO public.deals (lead_id, unit_id, responsible_user_id, status) VALUES (71, 501, 2, 'SIGNED')`);
    await OutboxWorkerService.runOnce({ workerId: 'w1' });
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.tasks WHERE lead_id = 71`)).rows[0].c).toBe(0);

    // 3. Failure writing crm_automation_executions rolls back task/notification atomically
    await state.db.exec(`
      CREATE OR REPLACE FUNCTION public.fail_exec_log() RETURNS TRIGGER AS $$
      BEGIN RAISE EXCEPTION 'EXEC_LOG_WRITE_FAILED'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_fail_exec_log BEFORE INSERT ON public.crm_automation_executions FOR EACH ROW EXECUTE FUNCTION public.fail_exec_log();
    `);
    await state.db.query(`INSERT INTO public.crm_automation_rules (id, name, event_type, action_type, is_enabled) VALUES (10, 'Rule 10', 'LEAD_CREATED', 'CREATE_TASK', true)`);
    await state.db.query(`INSERT INTO public.leads (id, full_name, status, stage, responsible_user_id, interested_project_id) VALUES (72, 'Rollback 72', 'NEW', 'NEW', 2, 1)`);
    const rRoll = await OutboxWorkerService.runOnce({ workerId: 'w1' });
    expect(rRoll.retried).toBe(1);
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.tasks WHERE lead_id = 72`)).rows[0].c).toBe(0);
    await state.db.exec(`DROP TRIGGER IF EXISTS trg_fail_exec_log ON public.crm_automation_executions;`);
  });
});
