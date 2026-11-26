import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const state = {
  db: null,
  failProjectAccessQuery: false
};

function createPgliteSupabaseAdapter() {
  return {
    from(table) {
      const filters = [];
      const builder = {
        select() {
          return builder;
        },
        eq(col, val) {
          filters.push({ col, val });
          return builder;
        },
        order() {
          return builder;
        },
        async _exec() {
          if (table === 'user_project_access' && state.failProjectAccessQuery) {
            return { data: null, error: { message: 'connection failure reading user_project_access' } };
          }
          const clauses = [];
          const params = [];
          filters.forEach((f, idx) => {
            clauses.push(`${f.col} = $${idx + 1}`);
            params.push(f.val);
          });
          const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
          const result = await state.db.query(`SELECT * FROM public.${table} ${whereSql}`, params);
          return { data: result.rows, error: null };
        },
        async single() {
          const { data, error } = await builder._exec();
          if (error) return { data: null, error };
          if (!data || data.length === 0) {
            return { data: null, error: { code: 'PGRST116', message: 'No rows' } };
          }
          return { data: data[0], error: null };
        },
        then(resolve, reject) {
          return builder._exec().then(resolve, reject);
        }
      };
      return builder;
    },
    async rpc(fnName, paramsObj) {
      const args = [JSON.stringify(paramsObj?.p_filters || {}), JSON.stringify(paramsObj?.p_scope || {})];
      const result = await state.db.query(`SELECT public.${fnName}($1::jsonb, $2::jsonb) AS res`, args);
      return { data: result.rows[0]?.res || null, error: null };
    }
  };
}

vi.mock('../../../db/connection.js', () => ({
  getDB: () => createPgliteSupabaseAdapter(),
  getServiceDB: () => createPgliteSupabaseAdapter(),
  getSecureDB: () => createPgliteSupabaseAdapter()
}));

import leadsRouter from '../leads.router.js';

function createRealApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/leads', leadsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({
      status: 'error',
      message: err.message
    });
  });
  return app;
}

function signToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

describe('R04.2: Real HTTP Integration (protect -> UsersRepository -> user_project_access -> queryUnified -> PostgreSQL)', () => {
  beforeAll(async () => {
    process.env.JWT_SECRET = 'test-jwt-secret-r04-2';
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
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'SALES_MANAGER',
        permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
        is_active INT NOT NULL DEFAULT 1,
        is_sales_rep BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

    await db.exec(readFileSync('src/db/migrations/060_crm_sales_completion_foundation.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/064_unified_lead_query_and_cursor.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/065_harden_unified_query_cursor_and_scope.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/066_user_project_access.sql', 'utf8'));

    await db.exec(`
      INSERT INTO public.projects (id, name) VALUES (1, 'Project Alpha'), (2, 'Project Beta');
      INSERT INTO public.users (id, name, email, role, permissions, is_active, is_sales_rep, all_projects_access) VALUES
        (1, 'Global Admin', 'admin@tozon.crm', 'ADMIN', '["*"]'::jsonb, 1, false, true),
        (2, 'Scoped Director', 'dir@tozon.crm', 'DIRECTOR', '["leads.view"]'::jsonb, 1, false, false),
        (3, 'Manager A', 'mgra@tozon.crm', 'SALES_MANAGER', '["leads.view"]'::jsonb, 1, true, false),
        (4, 'Manager No Projects', 'mgr0@tozon.crm', 'SALES_MANAGER', '["leads.view"]'::jsonb, 1, true, false),
        (5, 'Manager B', 'mgrb@tozon.crm', 'SALES_MANAGER', '["leads.view"]'::jsonb, 1, true, false);

      INSERT INTO public.user_project_access (user_id, project_id, can_view) VALUES
        (2, 1, true),
        (3, 1, true),
        (5, 2, true);

      INSERT INTO public.leads (id, full_name, phone, status, stage, responsible_user_id, interested_project_id, created_at) VALUES
        (101, 'Mgr A Proj 1', '+992900000101', 'NEW', 'NEW', 3, 1, '2026-11-26T10:00:00Z'),
        (102, 'Mgr A Proj 2 (Forbidden)', '+992900000102', 'NEW', 'NEW', 3, 2, '2026-11-26T10:01:00Z'),
        (103, 'Mgr B Proj 1 (Foreign Mgr)', '+992900000103', 'NEW', 'NEW', 5, 1, '2026-11-26T10:02:00Z'),
        (104, 'Mgr B Proj 2', '+992900000104', 'NEW', 'NEW', 5, 2, '2026-11-26T10:03:00Z');
    `);

    state.db = db;
  }, 30000);

  beforeEach(() => {
    state.failProjectAccessQuery = false;
  });

  it('SALES_MANAGER sees only own lead in allowed project across list, board, stats, and export', async () => {
    const app = createRealApp();
    const token = signToken(3);

    const listRes = await request(app).get('/api/leads').set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.total).toBe(1);
    expect(listRes.body.data.leads.map((l) => l.id)).toEqual([101]);

    const boardRes = await request(app).get('/api/leads/board').set('Authorization', `Bearer ${token}`);
    expect(boardRes.status).toBe(200);
    expect(boardRes.body.data.total).toBe(1);
    expect(boardRes.body.data.boardColumns.NEW.leads.map((l) => l.id)).toEqual([101]);

    const statsRes = await request(app).get('/api/leads/stats').set('Authorization', `Bearer ${token}`);
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.data.total).toBe(1);

    const exportRes = await request(app).get('/api/leads/export?format=csv').set('Authorization', `Bearer ${token}`);
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers['x-export-expected-count']).toBe('1');
    expect(exportRes.text).toContain('Mgr A Proj 1');
    expect(exportRes.text).not.toContain('Mgr A Proj 2');
    expect(exportRes.text).not.toContain('Mgr B Proj 1');
  });

  it('SALES_MANAGER with empty user_project_access gets 0 rows across all endpoints (fail-closed)', async () => {
    const app = createRealApp();
    const token = signToken(4);

    const listRes = await request(app).get('/api/leads').set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.total).toBe(0);
    expect(listRes.body.data.leads).toEqual([]);

    const boardRes = await request(app).get('/api/leads/board').set('Authorization', `Bearer ${token}`);
    expect(boardRes.status).toBe(200);
    expect(boardRes.body.data.total).toBe(0);
  });

  it('DIRECTOR with all_projects_access=false is strictly restricted to assigned project 1', async () => {
    const app = createRealApp();
    const token = signToken(2);

    const listRes = await request(app).get('/api/leads').set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.total).toBe(2);
    expect(listRes.body.data.leads.map((l) => l.id).sort()).toEqual([101, 103]);
  });

  it('ADMIN with explicit all_projects_access=true sees all projects (all 4 leads)', async () => {
    const app = createRealApp();
    const token = signToken(1);

    const listRes = await request(app).get('/api/leads').set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.total).toBe(4);
    expect(listRes.body.data.leads.map((l) => l.id).sort()).toEqual([101, 102, 103, 104]);
  });

  it('returns explicit 503 error (NOT empty 200 and NOT expanded scope) when loading project permissions fails', async () => {
    const app = createRealApp();
    const token = signToken(3);
    state.failProjectAccessQuery = true;

    const listRes = await request(app).get('/api/leads').set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(503);
    expect(listRes.body.status).toBe('error');
  });
});
