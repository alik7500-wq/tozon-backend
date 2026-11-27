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
        eq(col, val) { filters.push({ col, val }); return builder; },
        order(col, opts = {}) { orderCol = col; orderAsc = opts.ascending !== false; return builder; },
        async _exec() {
          const clauses = [];
          const params = [];
          filters.forEach((f, idx) => { clauses.push(`${f.col} = $${idx + 1}`); params.push(f.val); });
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
        insert(rows) {
          const runInsert = async () => {
            const r = rows[0];
            const cols = Object.keys(r);
            const vals = cols.map((c) => r[c]);
            const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
            const res = await state.db.query(
              `INSERT INTO public.${table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
              vals
            );
            return { data: res.rows, error: null };
          };
          return {
            select() { return { single: async () => { const r = await runInsert(); return { data: r.data[0], error: r.error }; } }; },
            then(resolve, reject) { return runInsert().then(resolve, reject); }
          };
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
                  params.push(v);
                });
                const clauses = filters.map((f) => {
                  params.push(f.val);
                  return `${f.col} = $${params.length}`;
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
    }
  };
}

vi.mock('../../../db/connection.js', () => ({
  getDB: () => createPgliteSupabaseAdapter(),
  getServiceDB: () => createPgliteSupabaseAdapter(),
  getSecureDB: () => createPgliteSupabaseAdapter()
}));

vi.mock('../../../middleware/auth.middleware.js', () => ({
  protect: (req, _res, next) => { req.user = state.authUser; next(); }
}));

import tasksRouter from '../tasks.router.js';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ status: 'error', message: err.message });
  });
  return app;
}

describe('GAP-08 Backend: Tasks API & Repository Exact due_at, Date-Only & Overdue', () => {
  beforeAll(async () => {
    const db = new PGlite();
    await db.exec(`
      CREATE TABLE public.users (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE public.leads (id BIGSERIAL PRIMARY KEY, full_name TEXT NOT NULL, phone TEXT);
      CREATE TABLE public.deals (id BIGSERIAL PRIMARY KEY, contract_number TEXT);
      CREATE TABLE public.tasks (
        id BIGSERIAL PRIMARY KEY,
        lead_id BIGINT REFERENCES public.leads(id),
        deal_id BIGINT REFERENCES public.deals(id),
        assigned_user_id BIGINT REFERENCES public.users(id),
        created_by BIGINT,
        type TEXT NOT NULL DEFAULT 'CALL',
        title TEXT NOT NULL,
        description TEXT,
        client_name TEXT,
        phone TEXT,
        project_name TEXT,
        unit_number TEXT,
        due_date TEXT,
        due_at TIMESTAMPTZ,
        due_date_only BOOLEAN NOT NULL DEFAULT TRUE,
        timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Dushanbe',
        rule_key VARCHAR(100),
        event_ref VARCHAR(255),
        priority TEXT DEFAULT 'NORMAL',
        status TEXT NOT NULL DEFAULT 'OPEN',
        idempotency_key VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO public.users (id, name) VALUES (1, 'Admin');
    `);
    state.db = db;
  }, 20000);

  beforeEach(async () => {
    await state.db.exec(`TRUNCATE public.tasks RESTART IDENTITY CASCADE`);
  });

  it('persists due_at in UTC, derives Asia/Dushanbe due_date on UTC boundary, and clears due_at when switched to due_date_only', async () => {
    const app = createTestApp();

    // Create exact task at 2026-11-27 01:00 Asia/Dushanbe = 2026-11-26T20:00:00.000Z
    const createRes = await request(app).post('/api/tasks').send({
      title: 'Ночной/ранний звонок',
      due_at: '2026-11-26T20:00:00.000Z',
      due_date_only: false,
      timezone: 'Asia/Dushanbe'
    });
    expect(createRes.status).toBe(201);
    const taskId = createRes.body.data.task.id;
    expect(createRes.body.data.task.due_date).toBe('2026-11-27');
    expect(createRes.body.data.task.due_date_only).toBe(false);

    // Switch to date-only via PUT -> due_at must become NULL
    const updateRes = await request(app).put(`/api/tasks/${taskId}`).send({
      due_date_only: true,
      due_date: '2026-11-28',
      timezone: 'Asia/Dushanbe'
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.task.due_date_only).toBe(true);
    expect(updateRes.body.data.task.due_at).toBeNull();
    expect(updateRes.body.data.task.due_date).toBe('2026-11-28');
  });

  it('filters OVERDUE using exact due_at and 18:00 Asia/Dushanbe for date-only while excluding COMPLETED/CANCELLED', async () => {
    const app = createTestApp();
    const pastIso = new Date(Date.now() - 60000).toISOString();
    const futureIso = new Date(Date.now() + 3600000).toISOString();

    await state.db.query(
      `INSERT INTO public.tasks (title, due_date, due_at, due_date_only, status, assigned_user_id) VALUES
       ('Past Exact', '2026-11-27', $1, false, 'OPEN', 1),
       ('Future Exact', '2026-11-27', $2, false, 'OPEN', 1),
       ('Completed Past', '2020-01-01', '2020-01-01T10:00:00Z', false, 'COMPLETED', 1),
       ('Cancelled Past', '2020-01-01', '2020-01-01T10:00:00Z', false, 'CANCELLED', 1)`,
      [pastIso, futureIso]
    );

    const overdueRes = await request(app).get('/api/tasks?dateFilter=OVERDUE');
    expect(overdueRes.status).toBe(200);
    expect(overdueRes.body.data.tasks.map((t) => t.title)).toEqual(['Past Exact']);
  });

  it('derives due_date from due_at when contradicting due_date is sent, preserves deadline on title-only edit, updates only due_at, and switches both modes', async () => {
    const app = createTestApp();

    // 1. due_at + contradicting due_date -> due_at wins in Asia/Dushanbe (2026-11-26T20:00:00Z = 2026-11-27 01:00 TJT)
    const cRes = await request(app).post('/api/tasks').send({
      title: 'Граница суток',
      due_at: '2026-11-26T20:00:00.000Z',
      due_date: '2026-11-26', // contradicting UTC date
      due_date_only: false
    });
    expect(cRes.status).toBe(201);
    const id = cRes.body.data.task.id;
    expect(cRes.body.data.task.due_date).toBe('2026-11-27');

    // 2. Partial update of ONLY title -> preserves due_at, due_date, due_date_only
    const titleRes = await request(app).put(`/api/tasks/${id}`).send({ title: 'Только заголовок' });
    expect(titleRes.status).toBe(200);
    expect(new Date(titleRes.body.data.task.due_at).toISOString()).toBe('2026-11-26T20:00:00.000Z');
    expect(titleRes.body.data.task.due_date).toBe('2026-11-27');
    expect(titleRes.body.data.task.due_date_only).toBe(false);

    // 3. Partial update of ONLY due_at on existing exact task -> updates due_at and due_date in Asia/Dushanbe
    const dueOnlyRes = await request(app).put(`/api/tasks/${id}`).send({ due_at: '2026-11-27T21:00:00.000Z' }); // 2026-11-28 02:00 TJT
    expect(dueOnlyRes.status).toBe(200);
    expect(dueOnlyRes.body.data.task.due_date).toBe('2026-11-28');
    expect(dueOnlyRes.body.data.task.due_date_only).toBe(false);

    // 4. Switch DATETIME -> DATE_ONLY -> DATETIME
    const toDateOnly = await request(app).put(`/api/tasks/${id}`).send({ due_date_only: true, due_date: '2026-12-05' });
    expect(toDateOnly.status).toBe(200);
    expect(toDateOnly.body.data.task.due_at).toBeNull();
    expect(toDateOnly.body.data.task.due_date_only).toBe(true);

    const toDateTime = await request(app).put(`/api/tasks/${id}`).send({
      due_date_only: false,
      due_at: '2026-12-06T10:30:00+05:00'
    });
    expect(toDateTime.status).toBe(200);
    expect(new Date(toDateTime.body.data.task.due_at).toISOString()).toBe('2026-12-06T05:30:00.000Z');
    expect(toDateTime.body.data.task.due_date).toBe('2026-12-06');
    expect(toDateTime.body.data.task.due_date_only).toBe(false);
  });

  it('rejects invalid calendar date, due_at without timezone, string boolean, and contradictory mode with 400 (never 500)', async () => {
    const app = createTestApp();

    const rInvalidDate = await request(app).post('/api/tasks').send({
      title: 'Bad date',
      due_date: '2026-02-30',
      due_date_only: true
    });
    expect(rInvalidDate.status).toBe(400);

    const rNoTz = await request(app).post('/api/tasks').send({
      title: 'No tz',
      due_at: '2026-11-27T12:00:00',
      due_date_only: false
    });
    expect(rNoTz.status).toBe(400);

    const rStrBool = await request(app).post('/api/tasks').send({
      title: 'Str bool',
      due_date: '2026-11-27',
      due_date_only: 'false'
    });
    expect(rStrBool.status).toBe(400);

    const rContradict = await request(app).post('/api/tasks').send({
      title: 'Contradict',
      due_at: '2026-11-27T10:00:00Z',
      due_date_only: true
    });
    expect(rContradict.status).toBe(400);

    const rMissingDueAt = await request(app).post('/api/tasks').send({
      title: 'Missing due_at',
      due_date_only: false,
      due_at: null
    });
    expect(rMissingDueAt.status).toBe(400);
  });
});
