import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const state = {
  db: null,
  simulateLeadsQueryError: false
};

function createPgliteSupabaseAdapter() {
  return {
    from(table) {
      const filters = [];
      let orderCol = null;
      let orderAsc = true;
      let limitVal = null;
      let countMode = null;
      const builder = {
        select(_cols, opts = {}) { if (opts?.count) countMode = opts.count; return builder; },
        eq(col, val) { filters.push({ op: '=', col, val }); return builder; },
        neq(col, val) { filters.push({ op: '<>', col, val }); return builder; },
        is(col, val) { filters.push({ op: val === null ? 'IS NULL' : 'IS', col, val }); return builder; },
        in(col, vals) { filters.push({ op: 'IN', col, val: vals }); return builder; },
        order(col, opts = {}) { orderCol = col; orderAsc = opts.ascending !== false; return builder; },
        limit(n) { limitVal = n; return builder; },
        async _exec() {
          if (table === 'leads' && state.simulateLeadsQueryError) {
            return { data: null, error: { message: 'Simulated leads workload query error' } };
          }
          const clauses = [];
          const params = [];
          filters.forEach((f) => {
            if (f.op === 'IS NULL') {
              clauses.push(`${f.col} IS NULL`);
            } else if (f.op === 'IN') {
              params.push(f.val);
              clauses.push(`${f.col} = ANY($${params.length})`);
            } else {
              params.push(f.val);
              clauses.push(`${f.col} ${f.op} $${params.length}`);
            }
          });
          const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
          const orderSql = orderCol ? `ORDER BY ${orderCol} ${orderAsc ? 'ASC' : 'DESC'}` : '';
          const limitSql = limitVal ? `LIMIT ${Number(limitVal)}` : '';
          const res = await state.db.query(`SELECT * FROM public.${table} ${whereSql} ${orderSql} ${limitSql}`, params);
          return { data: res.rows, count: countMode ? res.rows.length : null, error: null };
        },
        async maybeSingle() {
          const { data, error } = await builder._exec();
          if (error) return { data: null, error };
          return { data: data?.[0] || null, error: null };
        },
        async single() {
          const { data, error } = await builder._exec();
          if (error) return { data: null, error };
          if (!data || data.length === 0) return { data: null, error: { code: 'PGRST116', message: 'No rows' } };
          return { data: data[0], error: null };
        },
        update(patch) {
          return {
            eq(col, val) {
              filters.push({ op: '=', col, val });
              const runUpdate = async () => {
                const sets = [];
                const params = [];
                Object.entries(patch).forEach(([k, v], idx) => {
                  sets.push(`${k} = $${idx + 1}`);
                  params.push(v && typeof v === 'object' ? JSON.stringify(v) : v);
                });
                const clauses = filters.map((f, idx) => {
                  params.push(f.val);
                  return `${f.col} = $${params.length}`;
                });
                const res = await state.db.query(
                  `UPDATE public.${table} SET ${sets.join(', ')} WHERE ${clauses.join(' AND ')} RETURNING *`,
                  params
                );
                return { data: res.rows[0] || null, error: null };
              };
              return { select() { return { single: runUpdate, maybeSingle: runUpdate }; }, then(resolve, reject) { return runUpdate().then(resolve, reject); } };
            }
          };
        },
        then(resolve, reject) { return builder._exec().then(resolve, reject); }
      };
      return builder;
    },
    async rpc(fnName, paramsObj) {
      if (fnName === 'fn_select_and_assign_lead_atomic') {
        const res = await state.db.query(
          `SELECT public.fn_select_and_assign_lead_atomic($1, $2, $3, $4, $5::timestamptz) AS res`,
          [
            paramsObj.p_lead_id,
            paramsObj.p_actor_user_id,
            paramsObj.p_expected_version,
            paramsObj.p_assignment_source,
            paramsObj.p_now
          ]
        );
        return { data: res.rows[0]?.res || null, error: null };
      }
      if (fnName === 'fn_assign_lead_atomic') {
        const res = await state.db.query(
          `SELECT public.fn_assign_lead_atomic($1, $2, $3, $4, $5, $6, $7) AS res`,
          [
            paramsObj.p_lead_id,
            paramsObj.p_target_user_id,
            paramsObj.p_actor_user_id,
            paramsObj.p_reason,
            paramsObj.p_max_capacity,
            paramsObj.p_is_manual,
            paramsObj.p_expected_version
          ]
        );
        return { data: res.rows[0]?.res || null, error: null };
      }
      if (fnName === 'fn_run_lead_pool_batch') {
        const res = await state.db.query(
          `SELECT public.fn_run_lead_pool_batch($1, $2, $3::timestamptz) AS res`,
          [paramsObj.p_batch_size, paramsObj.p_ignore_enabled, paramsObj.p_now]
        );
        return { data: res.rows[0]?.res || null, error: null };
      }
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
      return { data: null, error: null };
    }
  };
}

vi.mock('../../../db/connection.js', () => ({
  getDB: () => createPgliteSupabaseAdapter(),
  getServiceDB: () => createPgliteSupabaseAdapter(),
  getSecureDB: () => createPgliteSupabaseAdapter()
}));

import { RoundRobinService } from '../roundRobin.service.js';
import { DistributionSettingsService } from '../distributionSettings.service.js';
import { LeadPoolWorkerService } from '../leadPoolWorker.service.js';
import { OutboxWorkerService } from '../../outbox/outboxWorker.service.js';

const WORKING_HOUR_ISO = '2026-11-27T06:00:00.000Z'; // 11:00 Asia/Dushanbe (Friday, after NOW())
const NIGHT_HOUR_ISO = '2026-11-27T20:00:00.000Z';   // 01:00 Asia/Dushanbe (Saturday night)

describe('R09.2 GAP-01: Transactional Project-Scoped Lead Distribution & Pool Worker', () => {
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
    await db.exec(readFileSync('src/db/migrations/061_harden_fn_assign_lead_atomic_and_app_rollback.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/062_atomic_lead_stage_transition.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/063_harden_stage_transition_and_task_cancel.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/066_user_project_access.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/068_outbox_worker_lease_and_controls.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/069_outbox_atomic_effect_guard.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/070_r09_1_outbox_and_project_access_tx.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/071_r09_2_gap01_transactional_distribution.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/072_r09_2_gap01_1_cross_project_capacity_and_pool_backoff.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/073_r09_2_gap01_2_pool_lock_order_and_manual_project_access.sql', 'utf8'));
    state.db = db;
  }, 30000);

  beforeEach(async () => {
    delete process.env.LEAD_POOL_WORKER_ENABLED;
    process.env.OUTBOX_WORKER_ENABLED = 'true';
    state.simulateLeadsQueryError = false;
    DistributionSettingsService.resetCache();
    await state.db.exec(`
      TRUNCATE public.crm_automation_executions, public.crm_automation_rules, public.crm_event_outbox,
               public.user_notifications, public.tasks, public.lead_stage_history, public.lead_assignment_history,
               public.user_project_access, public.deals, public.leads, public.projects, public.users,
               public.lead_distribution_settings RESTART IDENTITY CASCADE;

      INSERT INTO public.crm_outbox_settings (id, is_enabled, cutoff_at)
      VALUES (1, TRUE, '2020-01-01T00:00:00Z')
      ON CONFLICT (id) DO UPDATE SET is_enabled = TRUE, cutoff_at = '2020-01-01T00:00:00Z';

      INSERT INTO public.lead_distribution_settings
        (id, enabled, algorithm, max_open_leads_per_rep, excluded_user_ids, working_hours_only, work_start_hour, work_end_hour, pool_worker_enabled, round_robin_cursor)
      VALUES
        (1, TRUE, 'ROUND_ROBIN', 2, '[]'::jsonb, TRUE, 8, 20, FALSE, 0);

      INSERT INTO public.projects (id, name) VALUES (1, 'Project 1'), (2, 'Project 2');
      INSERT INTO public.users (id, name, email, role, is_active, is_sales_rep, all_projects_access) VALUES
        (1, 'Admin', 'a@t.tj', 'ADMIN', 1, FALSE, TRUE),
        (2, 'Mgr P1-A', 'm2@t.tj', 'SALES_MANAGER', 1, TRUE, FALSE),
        (3, 'Mgr P1-B', 'm3@t.tj', 'SALES_MANAGER', 1, TRUE, FALSE),
        (4, 'Mgr P2-Only', 'm4@t.tj', 'SALES_MANAGER', 1, TRUE, FALSE),
        (5, 'Mgr Inactive', 'm5@t.tj', 'SALES_MANAGER', 0, TRUE, TRUE);
      INSERT INTO public.user_project_access (user_id, project_id, can_view) VALUES
        (2, 1, TRUE), (3, 1, TRUE), (4, 2, TRUE);
    `);
  });

  it('routes strictly to project-authorized active reps, enforces capacity, and persists round-robin cursor across restarts', async () => {
    await state.db.query(`
      INSERT INTO public.leads (id, full_name, status, stage, interested_project_id) VALUES
        (101, 'L1', 'NEW', 'NEW', 1),
        (102, 'L2', 'NEW', 'NEW', 1),
        (103, 'L3', 'NEW', 'NEW', 2);
    `);

    const a1 = await RoundRobinService.assignLeadAtomic(101, { now: WORKING_HOUR_ISO });
    expect(a1).toMatchObject({ success: true, status: 'ASSIGNED', to_user_id: 2, cursor: 2 });

    // Simulated process restart: cursor is in PostgreSQL, next Proj 1 lead goes to Mgr 3
    const a2 = await RoundRobinService.assignLeadAtomic(102, { now: WORKING_HOUR_ISO });
    expect(a2).toMatchObject({ success: true, status: 'ASSIGNED', to_user_id: 3, cursor: 3 });

    // Proj 2 lead must ONLY go to Mgr 4
    const a3 = await RoundRobinService.assignLeadAtomic(103, { now: WORKING_HOUR_ISO });
    expect(a3).toMatchObject({ success: true, status: 'ASSIGNED', to_user_id: 4 });
  });

  it('excludes inactive, excluded, and full-capacity reps, and pools with clear pool_reason', async () => {
    await state.db.query(`UPDATE public.lead_distribution_settings SET excluded_user_ids = '[2]'::jsonb, max_open_leads_per_rep = 1 WHERE id = 1`);
    // Mgr 3 already has 1 open lead -> capacity full
    await state.db.exec(`
      INSERT INTO public.leads (id, full_name, status, stage, responsible_user_id, interested_project_id) VALUES
        (200, 'Existing', 'NEW', 'NEW', 3, 1);
      INSERT INTO public.leads (id, full_name, status, stage, interested_project_id) VALUES
        (201, 'Pooled', 'NEW', 'NEW', 1);
    `);

    const res = await RoundRobinService.assignLeadAtomic(201, { now: WORKING_HOUR_ISO });
    expect(res).toMatchObject({ success: true, status: 'POOLED', pool_reason: 'NO_ELIGIBLE_REPS' });

    const lead = (await state.db.query(`SELECT responsible_user_id, pool_reason FROM public.leads WHERE id = 201`)).rows[0];
    expect(lead.responsible_user_id).toBeNull();
    expect(lead.pool_reason).toBe('NO_ELIGIBLE_REPS');
  });

  it('never guesses workload as 0 on DB error and handles outside working hours / missing settings', async () => {
    await state.db.query(`UPDATE public.lead_distribution_settings SET working_hours_only = FALSE WHERE id = 1`);
    DistributionSettingsService.resetCache();
    state.simulateLeadsQueryError = true;
    await expect(RoundRobinService.getEligibleReps({ projectId: 1 })).rejects.toThrow(/нагрузки/i);
    const fallback = await RoundRobinService.resolveAssignment(null, null, { projectId: 1 });
    expect(fallback.responsible_user_id).toBeNull();
    expect(fallback.pool_reason).toBe('WORKLOAD_QUERY_FAILED');
    state.simulateLeadsQueryError = false;

    // Outside working hours -> OUTSIDE_WORKING_HOURS
    await state.db.query(`UPDATE public.lead_distribution_settings SET working_hours_only = TRUE WHERE id = 1`);
    await state.db.query(`INSERT INTO public.leads (id, full_name, status, stage, interested_project_id) VALUES (301, 'Night Lead', 'NEW', 'NEW', 1)`);
    const nightRes = await RoundRobinService.assignLeadAtomic(301, { now: NIGHT_HOUR_ISO });
    expect(nightRes).toMatchObject({ success: true, status: 'POOLED', pool_reason: 'OUTSIDE_WORKING_HOURS' });

    // Missing settings row -> SETTINGS_UNAVAILABLE
    await state.db.query(`DELETE FROM public.lead_distribution_settings WHERE id = 1`);
    const noSetRes = await RoundRobinService.assignLeadAtomic(301, { now: WORKING_HOUR_ISO });
    expect(noSetRes).toMatchObject({ success: true, status: 'POOLED', pool_reason: 'SETTINGS_UNAVAILABLE' });
  });

  it('prevents concurrent auto-assignments from exceeding manager capacity and handles manual vs auto race', async () => {
    await state.db.query(`UPDATE public.lead_distribution_settings SET max_open_leads_per_rep = 1, excluded_user_ids = '[3]'::jsonb WHERE id = 1`);
    await state.db.query(`
      INSERT INTO public.leads (id, full_name, status, stage, interested_project_id) VALUES
        (401, 'Race A', 'NEW', 'NEW', 1),
        (402, 'Race B', 'NEW', 'NEW', 1),
        (403, 'Manual vs Auto', 'NEW', 'NEW', 2);
    `);

    const [rA, rB] = await Promise.all([
      RoundRobinService.assignLeadAtomic(401, { now: WORKING_HOUR_ISO }),
      RoundRobinService.assignLeadAtomic(402, { now: WORKING_HOUR_ISO })
    ]);
    const assigned = [rA, rB].filter((r) => r.status === 'ASSIGNED');
    const pooled = [rA, rB].filter((r) => r.status === 'POOLED');
    expect(assigned).toHaveLength(1);
    expect(pooled).toHaveLength(1);
    expect(pooled[0].pool_reason).toBe('NO_ELIGIBLE_REPS');

    // Manual assign wins version 1 -> auto assign with expectedVersion=1 gets VERSION_CONFLICT
    const manualRes = (await state.db.query(`SELECT public.fn_assign_lead_atomic(403, 4, 1, 'Manual', 25, true, 1) AS res`)).rows[0].res;
    expect(manualRes.success).toBe(true);
    const autoStale = await RoundRobinService.assignLeadAtomic(403, { expectedVersion: 1, now: WORKING_HOUR_ISO });
    expect(autoStale).toMatchObject({ success: false, error_code: 'VERSION_CONFLICT', current_responsible_user_id: 4 });
  });

  it('runs pool worker safely (disabled by default, excludes LOST/archived/SIGNED, no duplicate tasks, no fresh SLA for historical import)', async () => {
    await state.db.exec(`
      INSERT INTO public.leads (id, full_name, status, stage, interested_project_id, pool_reason) VALUES
        (501, 'Pooled Active', 'NEW', 'NEW', 1, 'OUTSIDE_WORKING_HOURS'),
        (502, 'Pooled LOST', 'LOST', 'LOST', 1, 'NO_ELIGIBLE_REPS'),
        (503, 'Pooled Signed', 'CONTRACT_PREP', 'CONTRACT_PREP', 1, 'NO_ELIGIBLE_REPS');
      INSERT INTO public.leads (id, full_name, status, stage, interested_project_id, archived_at) VALUES
        (504, 'Pooled Archived', 'NEW', 'NEW', 1, NOW()::TEXT);
      INSERT INTO public.leads (id, full_name, status, stage, interested_project_id, is_historical_import) VALUES
        (505, 'Pooled Historical', 'NEW', 'NEW', 1, TRUE);
      INSERT INTO public.deals (id, lead_id, unit_id, responsible_user_id, status) VALUES
        (1, 503, 1, 2, 'SIGNED');
    `);

    // Disabled by default -> skipped
    const skipped = await LeadPoolWorkerService.runOnce({ now: WORKING_HOUR_ISO });
    expect(skipped).toMatchObject({ skipped: true, reason: 'POOL_WORKER_DISABLED_ENV_AND_DB', scanned: 0 });

    // Enable both env + db and run pool worker
    process.env.LEAD_POOL_WORKER_ENABLED = 'true';
    await state.db.query(`UPDATE public.lead_distribution_settings SET pool_worker_enabled = TRUE WHERE id = 1`);
    const run1 = await LeadPoolWorkerService.runOnce({ now: WORKING_HOUR_ISO });
    expect(run1).toMatchObject({ skipped: false, scanned: 2, assigned: 2, errors: 0 }); // only 501 and 505!

    // Re-running pool worker creates ZERO new assignments/history
    const run2 = await LeadPoolWorkerService.runOnce({ now: WORKING_HOUR_ISO });
    expect(run2).toMatchObject({ skipped: false, scanned: 0, assigned: 0 });
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.lead_assignment_history`)).rows[0].c).toBe(2);

    // Run outbox worker: 501 gets primary SLA task, 505 (historical import) does NOT get fresh SLA!
    await OutboxWorkerService.runOnce({ workerId: 'w_pool', now: WORKING_HOUR_ISO });
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.tasks WHERE lead_id = 501`)).rows[0].c).toBe(1);
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.tasks WHERE lead_id = 505`)).rows[0].c).toBe(0);
  });

  it('protects manager capacity across DIFFERENT projects, counts canonical open stages, and handles no-project + missing settings safely', async () => {
    await state.db.exec(`
      INSERT INTO public.users (id, name, email, role, is_active, is_sales_rep, all_projects_access)
      VALUES (6, 'CrossProj Mgr', 'm6@t.tj', 'SALES_MANAGER', 1, TRUE, TRUE);
      UPDATE public.lead_distribution_settings SET excluded_user_ids = '[2,3,4]'::jsonb, max_open_leads_per_rep = 1 WHERE id = 1;
      INSERT INTO public.lead_distribution_settings (id, project_id, enabled, algorithm, max_open_leads_per_rep, excluded_user_ids, working_hours_only, work_start_hour, work_end_hour)
      VALUES
        (2, 1, TRUE, 'LEAST_LOADED', 1, '[2,3,4]'::jsonb, FALSE, 8, 20),
        (3, 2, TRUE, 'LEAST_LOADED', 1, '[2,3,4]'::jsonb, FALSE, 8, 20);
      INSERT INTO public.leads (id, full_name, status, stage, interested_project_id) VALUES
        (601, 'Cross P1', 'NEW', 'NEW', 1),
        (602, 'Cross P2', 'NEW', 'NEW', 2);
    `);

    const [p1Res, p2Res] = await Promise.all([
      RoundRobinService.assignLeadAtomic(601, { now: WORKING_HOUR_ISO }),
      RoundRobinService.assignLeadAtomic(602, { now: WORKING_HOUR_ISO })
    ]);
    expect([p1Res, p2Res].filter((r) => r.status === 'ASSIGNED')).toHaveLength(1);
    expect([p1Res, p2Res].filter((r) => r.status === 'POOLED')).toHaveLength(1);

    // Lead with RESERVED stage counts toward capacity; SIGNED deal frees capacity
    await state.db.query(`UPDATE public.leads SET status = 'RESERVED', stage = 'RESERVED' WHERE responsible_user_id = 6`);
    await state.db.query(`INSERT INTO public.leads (id, full_name, status, stage, interested_project_id) VALUES (603, 'Blocked By Reserved', 'NEW', 'NEW', 1)`);
    const blockedRes = await RoundRobinService.assignLeadAtomic(603, { now: WORKING_HOUR_ISO });
    expect(blockedRes).toMatchObject({ success: true, status: 'POOLED', pool_reason: 'NO_ELIGIBLE_REPS' });

    // Lead without interested_project_id AND missing global settings row -> clean SETTINGS_UNAVAILABLE without SQL error
    await state.db.query(`DELETE FROM public.lead_distribution_settings WHERE id = 1`);
    await state.db.query(`INSERT INTO public.leads (id, full_name, status, stage, interested_project_id) VALUES (604, 'NoProj NoSettings', 'NEW', 'NEW', NULL)`);
    const noSetRes = await RoundRobinService.assignLeadAtomic(604, { now: WORKING_HOUR_ISO });
    expect(noSetRes).toMatchObject({ success: true, status: 'POOLED', pool_reason: 'SETTINGS_UNAVAILABLE' });
  });

  it('prevents pool starvation when first 25 leads belong to an unavailable project', async () => {
    process.env.LEAD_POOL_WORKER_ENABLED = 'true';
    await state.db.exec(`
      UPDATE public.lead_distribution_settings SET pool_worker_enabled = TRUE, max_open_leads_per_rep = 10 WHERE id = 1;
      INSERT INTO public.projects (id, name) VALUES (99, 'No-Rep Project');
      INSERT INTO public.leads (id, full_name, status, stage, interested_project_id, created_at)
      SELECT 700 + g, 'Blocked ' || g::text, 'NEW', 'NEW', 99, ('2026-11-26T01:' || LPAD(g::text, 2, '0') || ':00Z')
      FROM generate_series(1, 25) AS g;
      INSERT INTO public.leads (id, full_name, status, stage, interested_project_id, created_at)
      VALUES (726, 'Reachable P1', 'NEW', 'NEW', 1, '2026-11-26T02:00:00Z');
    `);

    // Run 1: processes first 25 (all Proj 99 -> POOLED with pool_next_attempt_at backoff)
    const run1 = await LeadPoolWorkerService.runOnce({ batchSize: 25, now: WORKING_HOUR_ISO });
    expect(run1).toMatchObject({ skipped: false, scanned: 25, pooled: 25, assigned: 0 });

    // Run 2 (10s later): skips backed-off 25 leads and immediately assigns 26th lead (#726)
    const tenSecLater = new Date(Date.parse(WORKING_HOUR_ISO) + 10000).toISOString();
    const run2 = await LeadPoolWorkerService.runOnce({ batchSize: 25, now: tenSecLater });
    expect(run2).toMatchObject({ skipped: false, scanned: 1, assigned: 1 });
    const l726 = (await state.db.query(`SELECT responsible_user_id FROM public.leads WHERE id = 726`)).rows[0];
    expect(l726.responsible_user_id).not.toBeNull();
  });

  it('enforces project access inside fn_assign_lead_atomic (including manual mode) with zero side effects on denial', async () => {
    await state.db.exec(`
      INSERT INTO public.users (id, name, email, role, is_active, is_sales_rep, all_projects_access) VALUES
        (7, 'AllProj Rep', 'm7@t.tj', 'SALES_MANAGER', 1, TRUE, TRUE),
        (8, 'NoProj Rep', 'm8@t.tj', 'SALES_MANAGER', 1, TRUE, FALSE);
      INSERT INTO public.leads (id, full_name, status, stage, interested_project_id) VALUES
        (801, 'P1 Lead', 'NEW', 'NEW', 1),
        (802, 'P2 Lead', 'NEW', 'NEW', 2),
        (803, 'NullProj Lead', 'NEW', 'NEW', NULL);
    `);

    // 1. Forbidden project (Mgr 2 only has Project 1, lead 802 is Project 2) -> PROJECT_ACCESS_DENIED, 0 history/outbox
    const denied = (await state.db.query(`SELECT public.fn_assign_lead_atomic(802, 2, 1, 'Manual cross-proj', 25, true, 1) AS res`)).rows[0].res;
    expect(denied).toMatchObject({ success: false, error_code: 'PROJECT_ACCESS_DENIED' });
    expect((await state.db.query(`SELECT responsible_user_id, version FROM public.leads WHERE id = 802`)).rows[0]).toEqual({ responsible_user_id: null, version: 1 });
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.lead_assignment_history WHERE lead_id = 802`)).rows[0].c).toBe(0);
    expect((await state.db.query(`SELECT COUNT(*)::int AS c FROM public.crm_event_outbox WHERE aggregate_id = '802' AND event_type = 'LEAD_ASSIGNED'`)).rows[0].c).toBe(0);

    // 2. Missing access (Mgr 8 has no project access at all) -> PROJECT_ACCESS_DENIED on both P1 and NULL project
    const noAccessP1 = (await state.db.query(`SELECT public.fn_assign_lead_atomic(801, 8, 1, 'Manual no-access', 25, true, 1) AS res`)).rows[0].res;
    expect(noAccessP1).toMatchObject({ success: false, error_code: 'PROJECT_ACCESS_DENIED' });
    const noAccessNull = (await state.db.query(`SELECT public.fn_assign_lead_atomic(803, 8, 1, 'Manual null-proj', 25, true, 1) AS res`)).rows[0].res;
    expect(noAccessNull).toMatchObject({ success: false, error_code: 'PROJECT_ACCESS_DENIED' });

    // 3. Allowed project (Mgr 2 has Project 1) -> ASSIGNED
    const okP1 = (await state.db.query(`SELECT public.fn_assign_lead_atomic(801, 2, 1, 'Manual allowed', 25, true, 1) AS res`)).rows[0].res;
    expect(okP1).toMatchObject({ success: true, status: 'ASSIGNED', to_user_id: 2 });

    // 4. all_projects_access = TRUE (Mgr 7) -> ASSIGNED on P2 and NULL project
    const okAllP2 = (await state.db.query(`SELECT public.fn_assign_lead_atomic(802, 7, 1, 'Manual all-proj P2', 25, true, 1) AS res`)).rows[0].res;
    expect(okAllP2).toMatchObject({ success: true, status: 'ASSIGNED', to_user_id: 7 });
    const okAllNull = (await state.db.query(`SELECT public.fn_assign_lead_atomic(803, 7, 1, 'Manual all-proj NULL', 25, true, 1) AS res`)).rows[0].res;
    expect(okAllNull).toMatchObject({ success: true, status: 'ASSIGNED', to_user_id: 7 });
  });
});
