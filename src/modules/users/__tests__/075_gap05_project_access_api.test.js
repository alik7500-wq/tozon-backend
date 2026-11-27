import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';

const state = {
  db: null,
  authUser: { id: 1, role: 'ADMIN', permissions: ['*'] }
};

function createPgliteSupabaseAdapter() {
  return {
    from(table) {
      const filters = [];
      let orderCol = null;
      let orderAsc = true;
      const builder = {
        select() { return builder; },
        eq(col, val) { filters.push({ op: '=', col, val }); return builder; },
        in(col, vals) { filters.push({ op: 'IN', col, val: vals }); return builder; },
        order(col, opts = {}) { orderCol = col; orderAsc = opts.ascending !== false; return builder; },
        async _exec() {
          const clauses = [];
          const params = [];
          filters.forEach((f) => {
            if (f.op === 'IN') {
              params.push(f.val);
              clauses.push(`${f.col} = ANY($${params.length})`);
            } else {
              params.push(f.val);
              clauses.push(`${f.col} = $${params.length}`);
            }
          });
          const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
          const orderSql = orderCol ? `ORDER BY ${orderCol} ${orderAsc ? 'ASC' : 'DESC'}` : '';
          const res = await state.db.query(`SELECT * FROM public.${table} ${whereSql} ${orderSql}`, params);
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
        then(resolve, reject) { return builder._exec().then(resolve, reject); }
      };
      return builder;
    },
    async rpc(fnName, paramsObj) {
      if (fnName === 'fn_set_user_project_access') {
        const res = await state.db.query(
          `SELECT public.fn_set_user_project_access($1, $2, $3::bigint[], $4) AS res`,
          [paramsObj.p_user_id, paramsObj.p_all_projects_access, paramsObj.p_project_ids || [], paramsObj.p_actor_id]
        );
        return { data: res.rows[0]?.res || null, error: null };
      }
      if (fnName === 'fn_query_leads_unified') {
        const res = await state.db.query(
          `SELECT public.fn_query_leads_unified($1::jsonb, $2::jsonb) AS res`,
          [JSON.stringify(paramsObj.p_filters || {}), JSON.stringify(paramsObj.p_scope || {})]
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
      const err = new Error('Доступ запрещён');
      err.statusCode = 403;
      return next(err);
    }
    next();
  }
}));

import usersRouter from '../users.router.js';
import { UsersRepository } from '../users.repository.js';
import { LeadsRepository } from '../../leads/leads.repository.js';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ status: 'error', message: err.message });
  });
  return app;
}

describe('GAP-05 Backend: PUT /api/users/:id/project-access RBAC, Non-Reassignment & Session Revocation', () => {
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
    await db.exec(readFileSync('src/db/migrations/064_unified_lead_query_and_cursor.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/065_harden_unified_query_cursor_and_scope.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/066_user_project_access.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/070_r09_1_outbox_and_project_access_tx.sql', 'utf8'));
    state.db = db;
  }, 30000);

  beforeEach(async () => {
    state.authUser = { id: 1, role: 'ADMIN', permissions: ['*'] };
    await state.db.exec(`
      TRUNCATE public.user_project_access, public.leads, public.projects, public.users RESTART IDENTITY CASCADE;
      INSERT INTO public.projects (id, name) VALUES (1, 'Proj 1'), (2, 'Proj 2');
      INSERT INTO public.users (id, name, email, role, permissions, is_active, is_sales_rep, all_projects_access) VALUES
        (1, 'Admin', 'a@t.tj', 'ADMIN', '["*"]'::jsonb, 1, false, true),
        (2, 'Manager A', 'm@t.tj', 'SALES_MANAGER', '["leads.view","leads.manage"]'::jsonb, 1, true, false),
        (3, 'Director', 'd@t.tj', 'DIRECTOR', '["users.view","users.manage"]'::jsonb, 1, false, true);
      INSERT INTO public.user_project_access (user_id, project_id, can_view) VALUES (2, 1, true);
      INSERT INTO public.leads (id, full_name, status, stage, responsible_user_id, interested_project_id) VALUES
        (10, 'Lead P1', 'NEW', 'NEW', 2, 1),
        (20, 'Lead P2', 'NEW', 'NEW', 2, 2);
    `);
  });

  it('forbids DIRECTOR and SALES_MANAGER from calling PUT /api/users/:id/project-access', async () => {
    const app = createTestApp();

    state.authUser = { id: 3, role: 'DIRECTOR', permissions: ['users.view', 'users.manage'] };
    const dirRes = await request(app)
      .put('/api/users/2/project-access')
      .send({ all_projects_access: true, allowed_project_ids: [] });
    expect(dirRes.status).toBe(403);

    state.authUser = { id: 2, role: 'SALES_MANAGER', permissions: ['leads.view', 'leads.manage'] };
    const mgrRes = await request(app)
      .put('/api/users/2/project-access')
      .send({ all_projects_access: true, allowed_project_ids: [] });
    expect(mgrRes.status).toBe(403);
  });

  it('updates project access without reassigning leads and immediately revokes lead visibility in open session', async () => {
    const app = createTestApp();

    // Before revocation: Manager A sees Lead P1 (#10)
    const beforeUser = await UsersRepository.findById(2);
    const beforeLeads = await LeadsRepository.queryUnified({}, beforeUser);
    expect(beforeLeads.leads.map((l) => Number(l.id))).toEqual([10]);

    // ADMIN revokes Project 1 from Manager A via HTTP PUT
    const res = await request(app)
      .put('/api/users/2/project-access')
      .send({ all_projects_access: false, allowed_project_ids: [] });
    expect(res.status).toBe(200);
    expect(res.body.data.user.all_projects_access).toBe(false);
    expect(res.body.data.user.allowed_project_ids).toEqual([]);

    // Leads are NOT automatically reassigned
    const leadRow = (await state.db.query(`SELECT responsible_user_id FROM public.leads WHERE id = 10`)).rows[0];
    expect(Number(leadRow.responsible_user_id)).toBe(2);

    // Same session next request (freshly loaded scope from UsersRepository.findById): Manager A sees 0 leads
    const afterUser = await UsersRepository.findById(2);
    const afterLeads = await LeadsRepository.queryUnified({}, afterUser);
    expect(afterLeads.leads).toEqual([]);
  });
});
