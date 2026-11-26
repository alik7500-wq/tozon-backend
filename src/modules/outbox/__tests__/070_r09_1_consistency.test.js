import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const state = { db: null };

function createPgliteSupabaseAdapter() {
  return {
    from(table) {
      const filters = [];
      let orderCol = null;
      let orderAsc = true;
      let limitVal = null;
      const builder = {
        select() { return builder; },
        eq(col, val) { filters.push({ col, val }); return builder; },
        order(col, opts = {}) { orderCol = col; orderAsc = opts.ascending !== false; return builder; },
        limit(n) { limitVal = n; return builder; },
        async _exec() {
          const clauses = [];
          const params = [];
          filters.forEach((f, idx) => { clauses.push(`${f.col} = $${idx + 1}`); params.push(f.val); });
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
              return { select() { return { single: runUpdate }; }, then(resolve, reject) { return runUpdate().then(resolve, reject); } };
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
        const res = await state.db.query(
          `SELECT public.fn_apply_outbox_effect($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb) AS res`,
          [
            paramsObj.p_event_id, paramsObj.p_lease_token, paramsObj.p_expected_lead_id,
            paramsObj.p_expected_assigned_user_id, paramsObj.p_require_open,
            JSON.stringify(paramsObj.p_tasks || []), JSON.stringify(paramsObj.p_notifications || []), JSON.stringify(paramsObj.p_rule_executions || [])
          ]
        );
        return { data: res.rows[0]?.res || null, error: null };
      }
      if (fnName === 'fn_set_user_project_access') {
        const res = await state.db.query(
          `SELECT public.fn_set_user_project_access($1, $2, $3::bigint[], $4) AS res`,
          [paramsObj.p_user_id, paramsObj.p_all_projects_access, paramsObj.p_project_ids || [], paramsObj.p_actor_id]
        );
        return { data: res.rows[0]?.res || null, error: null };
      }
      if (fnName === 'fn_outbox_diagnostics') {
        const res = await state.db.query(`SELECT public.fn_outbox_diagnostics() AS res`);
        return { data: res.rows[0]?.res || null, error: null };
      }
      if (fnName === 'fn_outbox_preview_cutoff') {
        const res = await state.db.query(`SELECT public.fn_outbox_preview_cutoff($1::timestamptz) AS res`, [paramsObj.p_cutoff_at]);
        return { data: res.rows[0]?.res || null, error: null };
      }
      if (fnName === 'fn_test_reassign_lead_helper') {
        await state.db.query(`UPDATE public.leads SET responsible_user_id = 3 WHERE id = $1`, [paramsObj.p_lead_id]);
        return { data: true, error: null };
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
import { UsersRepository } from '../../users/users.repository.js';

describe('R09.1: Outbox Recipient Consistency, Historical vs Live, Execution Modes, DB Diagnostics & Transactional Project Access', () => {
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
        id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT 'u@tozon.crm',
        role TEXT NOT NULL DEFAULT 'SALES_MANAGER', permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
        is_active INT NOT NULL DEFAULT 1, is_sales_rep BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    await db.exec(readFileSync('src/db/migrations/070_r09_1_outbox_and_project_access_tx.sql', 'utf8'));
    state.db = db;
  }, 30000);

  beforeEach(async () => {
    delete process.env.OUTBOX_WORKER_ENABLED;
    await state.db.exec(`
      TRUNCATE public.crm_automation_executions, public.crm_automation_rules, public.crm_event_outbox,
               public.user_notifications, public.tasks, public.lead_stage_history, public.lead_assignment_history,
               public.user_project_access, public.leads, public.projects, public.users RESTART IDENTITY CASCADE;
      INSERT INTO public.crm_outbox_settings (id, is_enabled, cutoff_at)
      VALUES (1, TRUE, '2020-01-01T00:00:00Z')
      ON CONFLICT (id) DO UPDATE SET is_enabled = TRUE, cutoff_at = '2020-01-01T00:00:00Z', last_success_at = NULL, last_error = NULL;
      INSERT INTO public.projects (id, name) VALUES (1, 'Proj 1'), (2, 'Proj 2');
      INSERT INTO public.users (id, name, email, role, is_active, is_sales_rep, all_projects_access) VALUES
        (1, 'Admin', 'a@t.tj', 'ADMIN', 1, false, true),
        (2, 'Mgr A', 'b@t.tj', 'SALES_MANAGER', 1, true, false),
        (3, 'Mgr B', 'c@t.tj', 'SALES_MANAGER', 1, true, false);
      INSERT INTO public.user_project_access (user_id, project_id, can_view) VALUES (2, 1, true), (3, 1, true);
    `);
  });

  it('prevents writing task/notification to stale Manager A when lead is reassigned to Manager B mid-flight', async () => {
    await state.db.query(`INSERT INTO public.leads (id, full_name, status, stage, responsible_user_id, interested_project_id) VALUES (10, 'Race 10', 'NEW', 'NEW', 2, 1)`);

    const res = await OutboxWorkerService.runOnce({ workerId: 'w1', injectFault: 'REASSIGN_BEFORE_APPLY' });
    expect(res.done).toBe(1);
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.tasks WHERE lead_id = 10`)).rows[0].c).toBe(0);
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.user_notifications WHERE entity_id = 10`)).rows[0].c).toBe(0);
  });

  it('computes primary SLA from business fact created_at (never extending on delayed queue/retry)', async () => {
    const businessCreatedAt = '2026-11-26T05:00:00.000Z'; // 10:00 Asia/Dushanbe
    await state.db.query(
      `INSERT INTO public.leads (id, full_name, status, stage, responsible_user_id, interested_project_id, created_at)
       VALUES (20, 'Delayed 20', 'NEW', 'NEW', 2, 1, $1)`,
      [businessCreatedAt]
    );

    await OutboxWorkerService.runOnce({ workerId: 'w1' });
    const task = (await state.db.query(`SELECT due_at FROM public.tasks WHERE lead_id = 20 AND rule_key = 'PRIMARY_FIRST_CONTACT'`)).rows[0];
    expect(new Date(task.due_at).toISOString()).toBe('2026-11-26T05:15:00.000Z');
  });

  it('skips historical LEAD_IMPORTED event but processes subsequent live events on that imported lead', async () => {
    await state.db.query(
      `INSERT INTO public.leads (id, full_name, status, stage, responsible_user_id, interested_project_id, is_historical_import)
       VALUES (30, 'Imported 30', 'NEW', 'NEW', 2, 1, true)`
    );
    await OutboxWorkerService.runOnce({ workerId: 'w1' });
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.tasks WHERE lead_id = 30`)).rows[0].c).toBe(0);

    // Subsequent live communication event on the imported contact -> MUST be processed!
    await state.db.query(
      `INSERT INTO public.lead_communications (lead_id, actor_user_id, channel, direction, event_type, outcome, project_id)
       VALUES (30, 2, 'CALL', 'OUTBOUND', 'NO_ANSWER', 'NO_ANSWER', 1)`
    );
    await OutboxWorkerService.runOnce({ workerId: 'w1' });
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.tasks WHERE lead_id = 30 AND rule_key = 'COMM_NO_ANSWER_FOLLOWUP'`)).rows[0].c).toBe(1);
  });

  it('evaluates all 4 combinations of OUTBOX_WORKER_ENABLED and crm_outbox_settings.is_enabled', async () => {
    // 1. (false, true)
    delete process.env.OUTBOX_WORKER_ENABLED;
    expect(await OutboxWorkerService.isOutboxWorkerActive()).toBe(false);
    expect((await OutboxWorkerService.getDiagnostics()).misconfiguredWarning).toContain('OUTBOX_WORKER_ENABLED!=true');

    // 2. (true, true)
    process.env.OUTBOX_WORKER_ENABLED = 'true';
    expect(await OutboxWorkerService.isOutboxWorkerActive()).toBe(true);
    expect((await OutboxWorkerService.getDiagnostics()).misconfiguredWarning).toBeNull();

    // 3. (true, false)
    await OutboxWorkerService.updateSettings({ isEnabled: false, actorUserId: 1 });
    expect(await OutboxWorkerService.isOutboxWorkerActive()).toBe(false);
    expect((await OutboxWorkerService.getDiagnostics()).misconfiguredWarning).toContain('is_enabled=false');

    // 4. (false, false)
    delete process.env.OUTBOX_WORKER_ENABLED;
    expect(await OutboxWorkerService.isOutboxWorkerActive()).toBe(false);
    expect((await OutboxWorkerService.getDiagnostics()).misconfiguredWarning).toBeNull();
  });

  it('replaces user project access transactionally and rolls back on invalid/non-existent project IDs', async () => {
    await expect(UsersRepository.setProjectAccess(2, { allProjectsAccess: 'yes', projectIds: [1], actorId: 1 })).rejects.toThrow(/boolean/);
    await expect(UsersRepository.setProjectAccess(2, { allProjectsAccess: true, projectIds: ['1', 'bad_id'], actorId: 1 })).rejects.toThrow(/Некорректный ID проекта/);
    await expect(UsersRepository.setProjectAccess(2, { allProjectsAccess: true, projectIds: [1, 9999], actorId: 1 })).rejects.toThrow(/несуществующий/);

    // Original state must be untouched after rollback
    const userAfterFail = await UsersRepository.findById(2);
    expect(userAfterFail.all_projects_access).toBe(false);
    expect(userAfterFail.allowed_project_ids).toEqual(['1']);

    // Valid transactional replacement succeeds
    const userOk = await UsersRepository.setProjectAccess(2, { allProjectsAccess: true, projectIds: [1, 2], actorId: 1 });
    expect(userOk.all_projects_access).toBe(true);
    expect(userOk.allowed_project_ids.sort()).toEqual(['1', '2']);
  });

  it('computes DB-side diagnostics beyond 1000 rows and does not set last_success_at on leaseLost', async () => {
    await state.db.query(
      `INSERT INTO public.crm_event_outbox (event_type, aggregate_type, aggregate_id, idempotency_key, payload_json)
       SELECT 'LEAD_CREATED', 'lead', g::text, 'bulk_k_' || g::text, '{}'::jsonb
       FROM generate_series(1, 1005) AS g`
    );
    const diag = await OutboxWorkerService.getDiagnostics();
    expect(diag.queueSize).toBe(1005);

    // Trigger leaseLost on 1 row -> last_success_at must remain NULL
    await state.db.query(`DELETE FROM public.crm_event_outbox`);
    await state.db.query(`INSERT INTO public.leads (id, full_name, status, stage, responsible_user_id, interested_project_id) VALUES (90, 'Lease 90', 'NEW', 'NEW', 2, 1)`);
    const res = await OutboxWorkerService.runOnce({ workerId: 'w1', injectFault: 'EXPIRE_LEASE_BEFORE_APPLY' });
    expect(res.leaseLost).toBe(1);
    const diag2 = await OutboxWorkerService.getDiagnostics();
    expect(diag2.settings.last_success_at).toBeNull();
    expect(diag2.settings.last_error).toBe('LEASE_LOST');
  });
});
