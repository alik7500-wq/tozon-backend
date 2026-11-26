import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const state = {
  db: null,
  liveEnabled: false,
  failSaveHistory: false
};

function createPgliteAdapter() {
  return {
    from(table) {
      const filters = [];
      const builder = {
        select() { return builder; },
        eq(col, val) { filters.push({ col, val }); return builder; },
        order() { return builder; },
        limit() { return builder; },
        async _exec() {
          if (table === 'instagram_threads') {
            const clauses = [];
            const params = [];
            filters.forEach((f, idx) => { clauses.push(`t.${f.col} = $${idx + 1}`); params.push(f.val); });
            const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
            const res = await state.db.query(
              `SELECT t.contact_id, t.instagram_account_id, t.lead_id, l.id AS l_id, l.responsible_user_id, l.interested_project_id
               FROM public.instagram_threads t LEFT JOIN public.leads l ON l.id = t.lead_id ${whereSql}`,
              params
            );
            return {
              data: res.rows.map((r) => ({
                contact_id: r.contact_id, instagram_account_id: r.instagram_account_id, lead_id: r.lead_id,
                leads: r.l_id ? { id: r.l_id, responsible_user_id: r.responsible_user_id, interested_project_id: r.interested_project_id } : null
              })),
              error: null
            };
          }
          const clauses = [];
          const params = [];
          filters.forEach((f, idx) => { clauses.push(`${f.col} = $${idx + 1}`); params.push(f.val); });
          const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
          const res = await state.db.query(`SELECT * FROM public.${table} ${whereSql}`, params);
          return { data: res.rows, error: null };
        },
        update(patch) {
          return {
            eq(col, val) {
              filters.push({ col, val });
              return {
                select() {
                  return {
                    async single() {
                      const sets = [];
                      const params = [];
                      Object.entries(patch).forEach(([k, v], idx) => {
                        sets.push(`${k} = $${idx + 1}`);
                        params.push(k === 'response_payload' && v !== null ? JSON.stringify(v) : v);
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
                    }
                  };
                }
              };
            }
          };
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
      if (fnName === 'fn_instagram_send_claim') {
        const res = await state.db.query(
          `SELECT public.fn_instagram_send_claim($1, $2, $3, $4, $5, $6, $7) AS res`,
          [
            paramsObj.p_actor_user_id, paramsObj.p_account_id, paramsObj.p_contact_id,
            paramsObj.p_idempotency_key, paramsObj.p_request_hash, paramsObj.p_normalized_text, paramsObj.p_lease_seconds
          ]
        );
        return { data: res.rows[0]?.res || null, error: null };
      }
      return { data: null, error: null };
    }
  };
}

vi.mock('../db/connection.js', () => ({
  getDB: () => createPgliteAdapter(),
  getServiceDB: () => createPgliteAdapter(),
  getSecureDB: () => createPgliteAdapter()
}));

const mockClient = {
  conversations: vi.fn(async () => ({ data: [], nextCursor: null })),
  messages: vi.fn(async () => ({ data: [], nextCursor: null })),
  send: vi.fn(async (contactId) => ({ messageId: `mid_${contactId}_1` }))
};

vi.mock('../modules/integrations/instagram-connection.repository.js', () => ({
  validInstagramAccountId: (id) => typeof id === 'string' && /^\d{5,40}$/.test(id),
  getTozonInstagramConnectionStatus: vi.fn(async () => ({ connected: true, accounts: [{ accountId: '11111', username: 'tozon', connected: true }] })),
  getInstagramInboxCredentials: vi.fn(async () => ({ accountId: '11111', token: 'mock-token' }))
}));

vi.mock('../modules/integrations/instagram-live.repository.js', () => ({
  liveInboxEnabled: () => state.liveEnabled,
  readInstagramThreads: vi.fn(async () => []),
  readInstagramHistory: vi.fn(async () => null),
  blockInstagramReply: vi.fn(async () => {}),
  saveInstagramThread: vi.fn(async () => {
    if (state.failSaveHistory) throw new Error('DB history write failed');
    return true;
  })
}));

vi.mock('../modules/integrations/instagram-inbox.client.js', async () => {
  const actual = await vi.importActual('../modules/integrations/instagram-inbox.client.js');
  return {
    ...actual,
    createInstagramInboxClient: () => mockClient
  };
});

import instagramInboxRouter from '../modules/integrations/instagram-inbox.router.js';
import { computeInstagramSendRequestHash } from '../modules/integrations/instagram-send.service.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/integrations/instagram', instagramInboxRouter);
  return app;
}

const tokenFor = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });

describe('R06: Durable Instagram Send Idempotency, Concurrent Claim, Unknown State & Reconciliation', () => {
  beforeAll(async () => {
    process.env.JWT_SECRET = 'test-jwt-secret-r06';
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
        id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'SALES_MANAGER', permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
        is_active INT NOT NULL DEFAULT 1, is_sales_rep BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE public.projects (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE public.leads (id BIGSERIAL PRIMARY KEY, full_name TEXT NOT NULL, responsible_user_id BIGINT, interested_project_id BIGINT);
      CREATE TABLE public.instagram_threads (id BIGSERIAL PRIMARY KEY, instagram_account_id TEXT NOT NULL, contact_id TEXT NOT NULL, lead_id BIGINT);
    `);
    await db.exec(readFileSync('src/db/migrations/066_user_project_access.sql', 'utf8'));
    await db.exec(readFileSync('src/db/migrations/067_instagram_send_idempotency.sql', 'utf8'));
    state.db = db;
  }, 30000);

  beforeEach(async () => {
    vi.clearAllMocks();
    mockClient.send.mockReset();
    mockClient.send.mockImplementation(async (contactId) => ({ messageId: `mid_${contactId}_1` }));
    state.liveEnabled = false;
    state.failSaveHistory = false;
    await state.db.exec(`
      TRUNCATE public.crm_instagram_send_operations, public.instagram_threads, public.user_project_access, public.leads, public.projects, public.users RESTART IDENTITY CASCADE;
      INSERT INTO public.projects (id, name) VALUES (1, 'Project 1');
      INSERT INTO public.users (id, name, email, role, permissions, is_active, all_projects_access) VALUES
        (2, 'Manager A', 'mgra@tozon.crm', 'SALES_MANAGER', '["access.v2","leads.view","leads.manage"]'::jsonb, 1, false),
        (3, 'Manager B', 'mgrb@tozon.crm', 'SALES_MANAGER', '["access.v2","leads.view","leads.manage"]'::jsonb, 1, false);
      INSERT INTO public.user_project_access (user_id, project_id, can_view) VALUES (2, 1, true), (3, 1, true);
      INSERT INTO public.leads (id, full_name, responsible_user_id, interested_project_id) VALUES (10, 'Client 42', 2, 1), (11, 'Client 43', 2, 1);
      INSERT INTO public.instagram_threads (instagram_account_id, contact_id, lead_id) VALUES ('11111', '42', 10), ('11111', '43', 11);
    `);
  });

  it('prevents duplicate external send on two concurrent HTTP requests with the same idempotency_key', async () => {
    let releaseSend;
    let markStarted;
    const sendStarted = new Promise((r) => { markStarted = r; });
    mockClient.send.mockImplementationOnce(() => new Promise((resolve) => {
      markStarted();
      releaseSend = () => resolve({ messageId: 'mid_concurrent_1' });
    }));

    const app = createApp();
    const token = tokenFor(2);

    const p1 = request(app).post('/api/integrations/instagram/send/11111/42')
      .set('Authorization', `Bearer ${token}`).send({ text: 'Салом', idempotency_key: 'ig_conc_key_1' })
      .then((r) => r);

    await sendStarted;

    const r2 = await request(app).post('/api/integrations/instagram/send/11111/42')
      .set('Authorization', `Bearer ${token}`).send({ text: 'Салом', idempotency_key: 'ig_conc_key_1' });
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('SEND_IN_PROGRESS');

    releaseSend();
    const r1 = await p1;
    expect(r1.status).toBe(200);
    expect(r1.body.deliveryStatus).toBe('confirmed');
    expect(mockClient.send).toHaveBeenCalledTimes(1);
  });

  it('replays confirmed operation without calling provider send again and rejects changed text/recipient with 409 IDEMPOTENCY_CONFLICT', async () => {
    const app = createApp();
    const token = tokenFor(2);

    const r1 = await request(app).post('/api/integrations/instagram/send/11111/42')
      .set('Authorization', `Bearer ${token}`).send({ text: 'Hello', idempotency_key: 'ig_replay_key_1' });
    expect(r1.status).toBe(200);
    expect(r1.body.deliveryStatus).toBe('confirmed');
    expect(mockClient.send).toHaveBeenCalledTimes(1);

    // Repeat identical request -> replayed, NO second send
    const r2 = await request(app).post('/api/integrations/instagram/send/11111/42')
      .set('Authorization', `Bearer ${token}`).send({ text: 'Hello', idempotency_key: 'ig_replay_key_1' });
    expect(r2.status).toBe(200);
    expect(r2.body.replayed).toBe(true);
    expect(mockClient.send).toHaveBeenCalledTimes(1);

    // Changed text -> 409 IDEMPOTENCY_CONFLICT
    const rDiffText = await request(app).post('/api/integrations/instagram/send/11111/42')
      .set('Authorization', `Bearer ${token}`).send({ text: 'Different', idempotency_key: 'ig_replay_key_1' });
    expect(rDiffText.status).toBe(409);
    expect(rDiffText.body.code).toBe('IDEMPOTENCY_CONFLICT');

    // Changed recipient -> 409 IDEMPOTENCY_CONFLICT
    const rDiffContact = await request(app).post('/api/integrations/instagram/send/11111/43')
      .set('Authorization', `Bearer ${token}`).send({ text: 'Hello', idempotency_key: 'ig_replay_key_1' });
    expect(rDiffContact.status).toBe(409);
    expect(rDiffContact.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(mockClient.send).toHaveBeenCalledTimes(1);
  });

  it('recovers history without re-sending when Meta accepted but local history write failed', async () => {
    state.liveEnabled = true;
    state.failSaveHistory = true;
    mockClient.send.mockResolvedValueOnce({ messageId: 'mid_saved_later' });

    const app = createApp();
    const token = tokenFor(2);

    const r1 = await request(app).post('/api/integrations/instagram/send/11111/42')
      .set('Authorization', `Bearer ${token}`).send({ text: 'Save retry', idempotency_key: 'ig_unsaved_key_1' });
    expect(r1.status).toBe(200);
    expect(r1.body.deliveryStatus).toBe('unknown');
    expect(r1.body.data.acceptedButUnsaved).toBe(true);
    expect(mockClient.send).toHaveBeenCalledTimes(1);

    // History DB recovers -> reconcile recovers without calling send
    state.failSaveHistory = false;
    const r2 = await request(app).post('/api/integrations/instagram/send/11111/42/reconcile')
      .set('Authorization', `Bearer ${token}`).send({ idempotency_key: 'ig_unsaved_key_1' });
    expect(r2.status).toBe(200);
    expect(r2.body.deliveryStatus).toBe('confirmed');
    expect(r2.body.data.saved).toBe(true);
    expect(mockClient.send).toHaveBeenCalledTimes(1);
  });

  it('marks lost response / timeout and expired-lease crash as UNKNOWN and never auto-retries external send', async () => {
    const app = createApp();
    const token = tokenFor(2);

    // 1. Timeout / lost response
    mockClient.send.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    const rTimeout = await request(app).post('/api/integrations/instagram/send/11111/42')
      .set('Authorization', `Bearer ${token}`).send({ text: 'Lost resp', idempotency_key: 'ig_lost_key_1' });
    expect(rTimeout.status).toBe(200);
    expect(rTimeout.body.deliveryStatus).toBe('unknown');
    expect(mockClient.send).toHaveBeenCalledTimes(1);

    // Repeat with same key -> still unknown, NO second send
    const rRepeat = await request(app).post('/api/integrations/instagram/send/11111/42')
      .set('Authorization', `Bearer ${token}`).send({ text: 'Lost resp', idempotency_key: 'ig_lost_key_1' });
    expect(rRepeat.status).toBe(200);
    expect(rRepeat.body.deliveryStatus).toBe('unknown');
    expect(mockClient.send).toHaveBeenCalledTimes(1);

    // 2. Simulated crashed process (IN_PROGRESS with expired lease)
    const hash = computeInstagramSendRequestHash({ actorUserId: 2, accountId: '11111', contactId: '42', text: 'Crash msg' });
    await state.db.query(
      `INSERT INTO public.crm_instagram_send_operations
        (actor_user_id, account_id, contact_id, idempotency_key, request_hash, normalized_text, status, lease_expires_at)
       VALUES (2, '11111', '42', 'ig_crash_key_1', $1, 'Crash msg', 'IN_PROGRESS', NOW() - interval '5 minutes')`,
      [hash]
    );
    const rCrash = await request(app).post('/api/integrations/instagram/send/11111/42')
      .set('Authorization', `Bearer ${token}`).send({ text: 'Crash msg', idempotency_key: 'ig_crash_key_1' });
    expect(rCrash.status).toBe(200);
    expect(rCrash.body.deliveryStatus).toBe('unknown');
    expect(mockClient.send).toHaveBeenCalledTimes(1);
  });

  it('enforces R05 access revocation before replay or reconcile', async () => {
    await state.db.query(`UPDATE public.leads SET responsible_user_id = 3 WHERE id = 10`);
    const app = createApp();
    const token = tokenFor(3);

    const r1 = await request(app).post('/api/integrations/instagram/send/11111/42')
      .set('Authorization', `Bearer ${token}`).send({ text: 'Before revoke', idempotency_key: 'ig_revoke_key_1' });
    expect(r1.status).toBe(200);
    expect(mockClient.send).toHaveBeenCalledTimes(1);

    // Revoke lead ownership
    await state.db.query(`UPDATE public.leads SET responsible_user_id = 2 WHERE id = 10`);

    const rReplay = await request(app).post('/api/integrations/instagram/send/11111/42')
      .set('Authorization', `Bearer ${token}`).send({ text: 'Before revoke', idempotency_key: 'ig_revoke_key_1' });
    expect(rReplay.status).toBe(403);

    const rReconcile = await request(app).post('/api/integrations/instagram/send/11111/42/reconcile')
      .set('Authorization', `Bearer ${token}`).send({ idempotency_key: 'ig_revoke_key_1' });
    expect(rReconcile.status).toBe(403);
    expect(mockClient.send).toHaveBeenCalledTimes(1);
  });
});
