import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';

const state = {
  db: null,
  simulateSettingsError: false,
  claimCalls: 0,
  authUser: { id: 1, role: 'ADMIN', permissions: ['settings.manage', 'settings.view'] }
};

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
          if (table === 'crm_outbox_settings' && state.simulateSettingsError) {
            return { data: null, error: { message: 'Simulated settings read failure' } };
          }
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
        state.claimCalls += 1;
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
      return { data: null, error: null };
    }
  };
}

vi.mock('../../../db/connection.js', () => ({
  getDB: () => createPgliteSupabaseAdapter(),
  getServiceDB: () => createPgliteSupabaseAdapter(),
  getSecureDB: () => createPgliteSupabaseAdapter()
}));

vi.mock('../../../middleware/auth.middleware.js', () => ({
  protect: (req, _res, next) => { req.user = state.authUser; next(); },
  restrictTo: (...roles) => (req, _res, next) => {
    if (!roles.includes(req.user?.role)) {
      const err = new Error('Forbidden');
      err.statusCode = 403;
      return next(err);
    }
    next();
  },
  checkPermission: (perm) => (req, _res, next) => {
    if (!req.user?.permissions?.includes(perm)) {
      const err = new Error('Forbidden permission');
      err.statusCode = 403;
      return next(err);
    }
    next();
  }
}));

import { OutboxWorkerService } from '../outboxWorker.service.js';
import outboxRouter from '../outbox.router.js';
import { runOutboxCli } from '../../../scripts/run-outbox-worker.js';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/outbox', outboxRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ status: 'error', message: err.message });
  });
  return app;
}

describe('R09.1.1: Centralized Outbox Execution Gate, HTTP Validation, Settings Error & CLI', () => {
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
    state.simulateSettingsError = false;
    state.claimCalls = 0;
    state.authUser = { id: 1, role: 'ADMIN', permissions: ['settings.manage', 'settings.view'] };
    await state.db.exec(`
      TRUNCATE public.crm_automation_executions, public.crm_automation_rules, public.crm_event_outbox,
               public.user_notifications, public.tasks, public.lead_stage_history, public.lead_assignment_history,
               public.user_project_access, public.leads, public.projects, public.users RESTART IDENTITY CASCADE;
      INSERT INTO public.crm_outbox_settings (id, is_enabled, cutoff_at)
      VALUES (1, FALSE, '2020-01-01T00:00:00Z')
      ON CONFLICT (id) DO UPDATE SET is_enabled = FALSE, cutoff_at = '2020-01-01T00:00:00Z', last_success_at = NULL, last_error = NULL, last_run_at = NULL;
      INSERT INTO public.projects (id, name) VALUES (1, 'Proj 1');
      INSERT INTO public.users (id, name, email, role, is_active, is_sales_rep, all_projects_access) VALUES
        (1, 'Admin', 'a@t.tj', 'ADMIN', 1, false, true),
        (2, 'Mgr A', 'b@t.tj', 'SALES_MANAGER', 1, true, true);
      INSERT INTO public.leads (id, full_name, status, stage, responsible_user_id, interested_project_id)
      VALUES (10, 'Gate Lead', 'NEW', 'NEW', 2, 1);
    `);
  });

  it('enforces all 4 flag combinations in real OutboxWorkerService.runOnce execution', async () => {
    const countSideEffects = async () => ({
      tasks: (await state.db.query(`SELECT COUNT(*)::int AS c FROM public.tasks`)).rows[0].c,
      notifs: (await state.db.query(`SELECT COUNT(*)::int AS c FROM public.user_notifications`)).rows[0].c,
      lastSuccess: (await state.db.query(`SELECT last_success_at FROM public.crm_outbox_settings WHERE id = 1`)).rows[0].last_success_at
    });

    // 1. (false, false)
    const r1 = await OutboxWorkerService.runOnce({ workerId: 'w_gate' });
    expect(r1).toMatchObject({ skipped: true, reason: 'OUTBOX_DISABLED_ENV_AND_DB', claimed: 0 });
    expect(state.claimCalls).toBe(0);
    expect(await countSideEffects()).toEqual({ tasks: 0, notifs: 0, lastSuccess: null });

    // 2. (false, true) -> still skipped because OUTBOX_WORKER_ENABLED != 'true'
    await state.db.query(`UPDATE public.crm_outbox_settings SET is_enabled = TRUE WHERE id = 1`);
    const r2 = await OutboxWorkerService.runOnce({ workerId: 'w_gate' });
    expect(r2).toMatchObject({ skipped: true, reason: 'OUTBOX_DISABLED_ENV', claimed: 0 });
    expect(state.claimCalls).toBe(0);
    expect(await countSideEffects()).toEqual({ tasks: 0, notifs: 0, lastSuccess: null });

    // 3. (true, false) -> skipped because crm_outbox_settings.is_enabled = false
    process.env.OUTBOX_WORKER_ENABLED = 'true';
    await state.db.query(`UPDATE public.crm_outbox_settings SET is_enabled = FALSE WHERE id = 1`);
    const r3 = await OutboxWorkerService.runOnce({ workerId: 'w_gate' });
    expect(r3).toMatchObject({ skipped: true, reason: 'OUTBOX_DISABLED_DB', claimed: 0 });
    expect(state.claimCalls).toBe(0);
    expect(await countSideEffects()).toEqual({ tasks: 0, notifs: 0, lastSuccess: null });

    // 4. (true, true) -> executes and creates task + notification + sets last_success_at
    await state.db.query(`UPDATE public.crm_outbox_settings SET is_enabled = TRUE WHERE id = 1`);
    const r4 = await OutboxWorkerService.runOnce({ workerId: 'w_gate' });
    expect(r4).toMatchObject({ skipped: false, claimed: 1, done: 1 });
    expect(state.claimCalls).toBe(1);
    const fx = await countSideEffects();
    expect(fx.tasks).toBe(1);
    expect(fx.notifs).toBe(1);
    expect(fx.lastSuccess).not.toBeNull();
  });

  it('executes and logs MANUAL_RUN_ONCE_OVERRIDE when ignoreEnabled=true even if both switches are off', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const res = await OutboxWorkerService.runOnce({
      workerId: 'api_1',
      ignoreEnabled: true,
      actorUserId: 1
    });
    expect(res).toMatchObject({ skipped: false, claimed: 1, done: 1 });
    expect(infoSpy).toHaveBeenCalledWith(
      '[outbox-worker]',
      expect.objectContaining({ action: 'MANUAL_RUN_ONCE_OVERRIDE', actorUserId: 1, workerId: 'api_1' })
    );
    infoSpy.mockRestore();
  });

  it('blocks queue claim and does not update last_success_at on settings read error', async () => {
    process.env.OUTBOX_WORKER_ENABLED = 'true';
    state.simulateSettingsError = true;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await OutboxWorkerService.runOnce({ workerId: 'w_err' });
    expect(res).toMatchObject({ skipped: true, reason: 'SETTINGS_READ_ERROR', claimed: 0 });
    expect(state.claimCalls).toBe(0);
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.tasks`)).rows[0].c).toBe(0);
    expect((await state.db.query(`SELECT last_success_at FROM public.crm_outbox_settings WHERE id = 1`)).rows[0].last_success_at).toBeNull();
    warnSpy.mockRestore();
  });

  it('validates POST /api/outbox/run-once: rejects ignore_enabled="false" with 400, enforces ADMIN + settings.manage, and logs valid override', async () => {
    const app = createTestApp();

    // Non-admin -> 403
    state.authUser = { id: 2, role: 'SALES_MANAGER', permissions: ['settings.manage'] };
    const rRole = await request(app).post('/api/outbox/run-once').send({ ignore_enabled: true });
    expect(rRole.status).toBe(403);

    // Missing permission -> 403
    state.authUser = { id: 1, role: 'ADMIN', permissions: ['settings.view'] };
    const rPerm = await request(app).post('/api/outbox/run-once').send({ ignore_enabled: true });
    expect(rPerm.status).toBe(403);

    // String "false" -> 400, must NOT trigger override or claim
    state.authUser = { id: 1, role: 'ADMIN', permissions: ['settings.manage'] };
    const rStr = await request(app).post('/api/outbox/run-once').send({ ignore_enabled: 'false' });
    expect(rStr.status).toBe(400);
    expect(state.claimCalls).toBe(0);

    // Valid boolean true -> 200, executes and logs actorUserId + workerId
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const rOk = await request(app).post('/api/outbox/run-once').send({ ignore_enabled: true });
    expect(rOk.status).toBe(200);
    expect(rOk.body.data).toMatchObject({ skipped: false, claimed: 1, done: 1 });
    expect(infoSpy).toHaveBeenCalledWith(
      '[outbox-worker]',
      expect.objectContaining({ action: 'MANUAL_RUN_ONCE_OVERRIDE', actorUserId: 1, workerId: 'api_1' })
    );
    infoSpy.mockRestore();
  });

  it('enforces CLI switches without override and restricts --force-override to --once mode only', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // --force-override without --once -> rejected (exitCode 1), never starts daemon loop
    const resInvalid = await runOutboxCli({
      argv: ['node', 'run-outbox-worker.js', '--force-override'],
      env: {},
      service: OutboxWorkerService,
      logger
    });
    expect(resInvalid).toEqual({ exitCode: 1, error: 'FORCE_OVERRIDE_REQUIRES_ONCE' });
    expect(state.claimCalls).toBe(0);

    // --once without --force-override when disabled -> skipped, 0 claimed
    const resOnceDisabled = await runOutboxCli({
      argv: ['node', 'run-outbox-worker.js', '--once'],
      env: {},
      service: OutboxWorkerService,
      logger
    });
    expect(resOnceDisabled.exitCode).toBe(0);
    expect(resOnceDisabled.result).toMatchObject({ skipped: true, claimed: 0 });
    expect(state.claimCalls).toBe(0);

    // Daemon loop without override when env disabled -> skipped immediately
    const resLoopDisabled = await runOutboxCli({
      argv: ['node', 'run-outbox-worker.js'],
      env: {},
      service: OutboxWorkerService,
      logger
    });
    expect(resLoopDisabled).toEqual({ exitCode: 0, result: { skipped: true, reason: 'OUTBOX_DISABLED_ENV' } });

    // --once --force-override -> runs once with override
    const resOverride = await runOutboxCli({
      argv: ['node', 'run-outbox-worker.js', '--once', '--force-override'],
      env: {},
      service: OutboxWorkerService,
      logger
    });
    expect(resOverride.exitCode).toBe(0);
    expect(resOverride.result).toMatchObject({ skipped: false, claimed: 1, done: 1 });
    expect(logger.warn).toHaveBeenCalledWith('[outbox-cli] MANUAL_CLI_OVERRIDE enabled');
  });
});
