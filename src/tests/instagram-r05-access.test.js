import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const state = { db: null };

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
            filters.forEach((f, idx) => {
              clauses.push(`t.${f.col} = $${idx + 1}`);
              params.push(f.val);
            });
            const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
            const res = await state.db.query(
              `SELECT t.contact_id, t.instagram_account_id, t.lead_id,
                      l.id AS l_id, l.responsible_user_id, l.interested_project_id
               FROM public.instagram_threads t
               LEFT JOIN public.leads l ON l.id = t.lead_id
               ${whereSql}`,
              params
            );
            return {
              data: res.rows.map((r) => ({
                contact_id: r.contact_id,
                instagram_account_id: r.instagram_account_id,
                lead_id: r.lead_id,
                leads: r.l_id ? { id: r.l_id, responsible_user_id: r.responsible_user_id, interested_project_id: r.interested_project_id } : null
              })),
              error: null
            };
          }
          const clauses = [];
          const params = [];
          filters.forEach((f, idx) => {
            clauses.push(`${f.col} = $${idx + 1}`);
            params.push(f.val);
          });
          const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
          const res = await state.db.query(`SELECT * FROM public.${table} ${whereSql}`, params);
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
    }
  };
}

vi.mock('../db/connection.js', () => ({
  getDB: () => createPgliteAdapter(),
  getServiceDB: () => createPgliteAdapter(),
  getSecureDB: () => createPgliteAdapter()
}));

const mockClient = {
  conversations: vi.fn(async () => ({
    data: [
      { instagramAccountId: '11111', contactId: '42', name: 'Allowed Client' },
      { instagramAccountId: '11111', contactId: '77', name: 'Forbidden Project Client' },
      { instagramAccountId: '11111', contactId: '99', name: 'Foreign Manager Client' }
    ],
    nextCursor: 'NEXT_PAGE_1'
  })),
  messages: vi.fn(async (contactId) => ({
    data: [{ message_id: `msg_${contactId}`, text_content: `Hello ${contactId}`, is_echo: false }],
    nextCursor: null
  })),
  send: vi.fn(async (contactId, text) => ({ message_id: `sent_${contactId}`, text_content: text }))
};

vi.mock('../modules/integrations/instagram-connection.repository.js', () => ({
  validInstagramAccountId: (id) => typeof id === 'string' && /^\d{5,40}$/.test(id),
  getTozonInstagramConnectionStatus: vi.fn(async () => ({
    connected: true,
    available: true,
    accounts: [
      { accountId: '11111', username: 'tozon_proj1', connected: true },
      { accountId: '22222', username: 'tozon_proj2', connected: true }
    ]
  })),
  getInstagramInboxCredentials: vi.fn(async (accountId) => {
    const id = accountId || '11111';
    if (!['11111', '22222'].includes(id)) return null;
    return { accountId: id, token: 'mock-token' };
  }),
  disconnectInstagramAccount: vi.fn(async () => true),
  saveInstagramConnections: vi.fn(),
  isInstagramOAuthActorActive: vi.fn(async () => false)
}));

vi.mock('../modules/integrations/instagram-live.repository.js', () => ({
  liveInboxEnabled: () => false
}));

vi.mock('../modules/integrations/instagram-inbox.client.js', async () => {
  const actual = await vi.importActual('../modules/integrations/instagram-inbox.client.js');
  return {
    ...actual,
    createInstagramInboxClient: () => mockClient
  };
});

import instagramInboxRouter from '../modules/integrations/instagram-inbox.router.js';
import instagramAdminRouter from '../modules/integrations/instagram.router.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/integrations/instagram', instagramInboxRouter);
  app.use('/api/integrations/instagram', instagramAdminRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ status: 'error', message: err.message });
  });
  return app;
}

const tokenFor = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });

describe('R05: SALES_MANAGER access to Instagram Inbox through real protect + sectionAccess + R04.2 project scope', () => {
  beforeAll(async () => {
    process.env.JWT_SECRET = 'test-jwt-secret-r05';
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
      CREATE TABLE public.leads (
        id BIGSERIAL PRIMARY KEY, full_name TEXT NOT NULL, responsible_user_id BIGINT,
        interested_project_id BIGINT
      );
      CREATE TABLE public.instagram_threads (
        id BIGSERIAL PRIMARY KEY, instagram_account_id TEXT NOT NULL, contact_id TEXT NOT NULL,
        lead_id BIGINT REFERENCES public.leads(id)
      );
    `);
    await db.exec(readFileSync('src/db/migrations/066_user_project_access.sql', 'utf8'));
    state.db = db;
  }, 30000);

  beforeEach(async () => {
    vi.clearAllMocks();
    await state.db.exec(`
      TRUNCATE public.instagram_threads, public.user_project_access, public.leads, public.projects, public.users RESTART IDENTITY CASCADE;
      INSERT INTO public.projects (id, name) VALUES (1, 'Project 1'), (2, 'Project 2');
      INSERT INTO public.users (id, name, email, role, permissions, is_active, all_projects_access) VALUES
        (1, 'Admin', 'admin@tozon.crm', 'ADMIN', '["*"]'::jsonb, 1, true),
        (2, 'Manager Matrix Full', 'mgr1@tozon.crm', 'SALES_MANAGER', '["access.v2","leads.view","leads.manage"]'::jsonb, 1, false),
        (3, 'Manager Read Only', 'mgr2@tozon.crm', 'SALES_MANAGER', '["access.v2","leads.view"]'::jsonb, 1, false),
        (4, 'Manager B', 'mgrb@tozon.crm', 'SALES_MANAGER', '["access.v2","leads.view","leads.manage"]'::jsonb, 1, false);

      INSERT INTO public.user_project_access (user_id, project_id, can_view) VALUES
        (2, 1, true),
        (3, 1, true),
        (4, 2, true);

      INSERT INTO public.leads (id, full_name, responsible_user_id, interested_project_id) VALUES
        (10, 'Owned Allowed', 2, 1),
        (11, 'Owned Forbidden Proj', 2, 2),
        (12, 'Foreign Mgr Same Proj', 4, 1),
        (13, 'ReadOnly Owned', 3, 1);

      INSERT INTO public.instagram_threads (instagram_account_id, contact_id, lead_id) VALUES
        ('11111', '42', 10),
        ('11111', '77', 11),
        ('11111', '99', 12),
        ('22222', '55', 11),
        ('11111', '88', 13);
    `);
  });

  it('allows SALES_MANAGER to list safe accounts, read own thread & paginated list, and reply', async () => {
    const app = createApp();
    const token = tokenFor(2);

    const accRes = await request(app).get('/api/integrations/instagram/inbox/accounts').set('Authorization', `Bearer ${token}`);
    expect(accRes.status).toBe(200);
    expect(accRes.body.data.accounts).toEqual([{ accountId: '11111', username: 'tozon_proj1' }]);

    const convRes = await request(app).get('/api/integrations/instagram/inbox/conversations?account=11111').set('Authorization', `Bearer ${token}`);
    expect(convRes.status).toBe(200);
    expect(convRes.body.data.map((c) => c.contactId)).toEqual(['42']);

    const pageRes = await request(app).get('/api/integrations/instagram/inbox/conversations/page?account=11111&after=NEXT_PAGE_1').set('Authorization', `Bearer ${token}`);
    expect(pageRes.status).toBe(200);
    expect(pageRes.body.data.map((c) => c.contactId)).toEqual(['42']);

    const msgRes = await request(app).get('/api/integrations/instagram/inbox/conversations/11111/42/messages').set('Authorization', `Bearer ${token}`);
    expect(msgRes.status).toBe(200);
    expect(msgRes.body.data[0].message_id).toBe('msg_42');

    const sendRes = await request(app).post('/api/integrations/instagram/send/11111/42').set('Authorization', `Bearer ${token}`).send({ text: 'Hi' });
    expect(sendRes.status).toBe(200);
  });

  it('blocks foreign contact, forbidden project, spoofed account/cursor, and admin endpoints for SALES_MANAGER', async () => {
    const app = createApp();
    const token = tokenFor(2);

    const foreignMsg = await request(app).get('/api/integrations/instagram/inbox/conversations/11111/99/messages').set('Authorization', `Bearer ${token}`);
    expect(foreignMsg.status).toBe(403);

    const proj2Msg = await request(app).get('/api/integrations/instagram/inbox/conversations/11111/77/messages').set('Authorization', `Bearer ${token}`);
    expect(proj2Msg.status).toBe(403);

    const proj2Send = await request(app).post('/api/integrations/instagram/send/22222/55').set('Authorization', `Bearer ${token}`).send({ text: 'Hack' });
    expect(proj2Send.status).toBe(403);

    const spoofAccountList = await request(app).get('/api/integrations/instagram/inbox/conversations?account=22222').set('Authorization', `Bearer ${token}`);
    expect(spoofAccountList.status).toBe(200);
    expect(spoofAccountList.body.data).toEqual([]);
    expect(mockClient.conversations).not.toHaveBeenCalled();

    // Admin endpoints must be forbidden
    expect((await request(app).get('/api/integrations/instagram/connection').set('Authorization', `Bearer ${token}`)).status).toBe(403);
    expect((await request(app).post('/api/integrations/instagram/connect').set('Authorization', `Bearer ${token}`)).status).toBe(403);
    expect((await request(app).post('/api/integrations/instagram/accounts/11111/disconnect').set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });

  it('enforces section read vs write (leads.view without leads.manage cannot send)', async () => {
    const app = createApp();
    const readOnlyToken = tokenFor(3);

    expect((await request(app).get('/api/integrations/instagram/inbox/conversations/11111/88/messages').set('Authorization', `Bearer ${readOnlyToken}`)).status).toBe(200);
    expect((await request(app).post('/api/integrations/instagram/send/11111/88').set('Authorization', `Bearer ${readOnlyToken}`).send({ text: 'Blocked' })).status).toBe(403);
  });

  it('revokes access immediately in the same session on lead reassignment, project revocation, or deactivation', async () => {
    const app = createApp();
    const token = tokenFor(2);

    expect((await request(app).get('/api/integrations/instagram/inbox/conversations/11111/42/messages').set('Authorization', `Bearer ${token}`)).status).toBe(200);

    // 1. Reassign lead to another manager
    await state.db.query(`UPDATE public.leads SET responsible_user_id = 4 WHERE id = 10`);
    expect((await request(app).get('/api/integrations/instagram/inbox/conversations/11111/42/messages').set('Authorization', `Bearer ${token}`)).status).toBe(403);

    // Restore lead ownership, then revoke project access
    await state.db.query(`UPDATE public.leads SET responsible_user_id = 2 WHERE id = 10`);
    await state.db.query(`DELETE FROM public.user_project_access WHERE user_id = 2`);
    expect((await request(app).get('/api/integrations/instagram/inbox/conversations/11111/42/messages').set('Authorization', `Bearer ${token}`)).status).toBe(403);

    // Restore project access, then deactivate user
    await state.db.query(`INSERT INTO public.user_project_access (user_id, project_id, can_view) VALUES (2, 1, true)`);
    await state.db.query(`UPDATE public.users SET is_active = 0 WHERE id = 2`);
    expect((await request(app).get('/api/integrations/instagram/inbox/conversations/11111/42/messages').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });
});
