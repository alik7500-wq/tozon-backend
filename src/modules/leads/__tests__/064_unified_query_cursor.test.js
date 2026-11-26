import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { validateAndNormalizeLeadQuery, encodeLeadCursor } from '../leadFilterValidator.js';

async function setupDbWith064() {
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

    INSERT INTO public.users (id, name, role, is_active, is_sales_rep)
    VALUES (1, 'Director', 'DIRECTOR', 1, false), (2, 'Rep A', 'SALES_MANAGER', 1, true), (3, 'Rep B', 'SALES_MANAGER', 1, true);
    INSERT INTO public.projects (id, name) VALUES (1, 'TOZON PLAZA'), (2, 'Somon Residence');
  `);

  await db.exec(readFileSync('src/db/migrations/060_crm_sales_completion_foundation.sql', 'utf8'));
  await db.exec(readFileSync('src/db/migrations/064_unified_lead_query_and_cursor.sql', 'utf8'));
  await db.exec(readFileSync('src/db/migrations/065_harden_unified_query_cursor_and_scope.sql', 'utf8'));
  return db;
}

describe('R04: Unified DB Query, Canonical Stage Filtering, Timezone [from, to), and Keyset Cursor', () => {
  it('handles >page volume, identical created_at tie-breaking, and new insert between pages without skips or duplicates', async () => {
    const db = await setupDbWith064();

    // Insert 12 leads, 4 of which share the exact same created_at timestamp
    const sameTs = '2026-11-25T10:00:00.000Z';
    for (let i = 1; i <= 12; i += 1) {
      const ts = i <= 4 ? sameTs : new Date(Date.UTC(2026, 10, 25, 10, i, 0)).toISOString();
      await db.query(
        `INSERT INTO public.leads (id, full_name, phone, status, stage, responsible_user_id, interested_project_id, created_at)
         VALUES ($1, $2, $3, 'NEW', 'NEW', 2, 1, $4)`,
        [i, `Lead ${i}`, `+9929000000${String(i).padStart(2, '0')}`, ts]
      );
    }

    const user = { id: 1, role: 'DIRECTOR' };
    const collectedIds = [];
    let cursor = null;

    // Page 1 (limit 5)
    const q1 = validateAndNormalizeLeadQuery({ limit: '5' }, user);
    const r1 = (await db.query(`SELECT public.fn_query_leads_unified($1::jsonb, $2::jsonb) AS res`, [JSON.stringify(q1.dbFilters), JSON.stringify(q1.dbScope)])).rows[0].res;
    expect(r1.total).toBe(12);
    expect(r1.leads).toHaveLength(5);
    collectedIds.push(...r1.leads.map((l) => l.id));
    cursor = encodeLeadCursor(r1.leads[r1.leads.length - 1], q1.filterHash);

    // Insert a brand-new lead BETWEEN page 1 and page 2
    await db.query(
      `INSERT INTO public.leads (id, full_name, phone, status, stage, responsible_user_id, interested_project_id, created_at)
       VALUES (99, 'New Mid-Scroll Lead', '+992900000099', 'NEW', 'NEW', 2, 1, '2026-11-26T00:00:00.000Z')`
    );

    // Page 2 (limit 5) -> must NOT duplicate any page 1 item or skip any item
    const q2 = validateAndNormalizeLeadQuery({ limit: '5', cursor }, user);
    const r2 = (await db.query(`SELECT public.fn_query_leads_unified($1::jsonb, $2::jsonb) AS res`, [JSON.stringify(q2.dbFilters), JSON.stringify(q2.dbScope)])).rows[0].res;
    expect(r2.leads).toHaveLength(5);
    collectedIds.push(...r2.leads.map((l) => l.id));
    cursor = encodeLeadCursor(r2.leads[r2.leads.length - 1], q2.filterHash);

    // Page 3 (remaining 2)
    const q3 = validateAndNormalizeLeadQuery({ limit: '5', cursor }, user);
    const r3 = (await db.query(`SELECT public.fn_query_leads_unified($1::jsonb, $2::jsonb) AS res`, [JSON.stringify(q3.dbFilters), JSON.stringify(q3.dbScope)])).rows[0].res;
    expect(r3.leads).toHaveLength(2);
    collectedIds.push(...r3.leads.map((l) => l.id));

    // All 12 original IDs collected with zero duplicates
    expect(new Set(collectedIds).size).toBe(12);
    expect(collectedIds.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  }, 30000);

  it('does not multiply total on multiple tasks/deals, separates SIGNED vs legacy WON, and enforces Asia/Dushanbe [from, to) & RBAC', async () => {
    const db = await setupDbWith064();

    // Lead 1: Legacy WON without SIGNED deal + 2 open tasks (must count as 1 CONTRACT_PREP, not SIGNED)
    await db.query(`INSERT INTO public.leads (id, full_name, status, stage, responsible_user_id, interested_project_id, created_at) VALUES (1, 'Legacy WON', 'WON', 'CONTRACT_PREP', 2, 1, '2026-11-25T22:00:00.000Z')`);
    await db.query(`INSERT INTO public.tasks (lead_id, type, title, status, due_at) VALUES (1, 'CALL', 'Task 1', 'OPEN', NOW() + interval '1 hour'), (1, 'MEETING', 'Task 2', 'OPEN', NOW() + interval '2 hour')`);

    // Lead 2: Confirmed SIGNED buyer with 2 deals (CANCELLED + SIGNED) -> counts as 1 SIGNED
    await db.query(`INSERT INTO public.leads (id, full_name, status, stage, responsible_user_id, interested_project_id, created_at) VALUES (2, 'Signed Buyer', 'WON', 'SIGNED', 3, 2, '2026-11-25T10:00:00.000Z')`);
    await db.query(`INSERT INTO public.deals (lead_id, unit_id, responsible_user_id, status) VALUES (2, 101, 3, 'CANCELLED'), (2, 102, 3, 'SIGNED')`);

    // Lead 3: Paused lead (no open task, has pause_until)
    await db.query(`INSERT INTO public.leads (id, full_name, status, stage, responsible_user_id, interested_project_id, pause_until, pause_reason, created_at) VALUES (3, 'Paused Lead', 'IN_PROGRESS', 'IN_PROGRESS', 2, 1, NOW() + interval '2 days', 'Отпуск', '2026-11-25T12:00:00.000Z')`);

    // Check SIGNED filter for Director: only Lead 2 (not Lead 1 legacy WON)
    const qSigned = validateAndNormalizeLeadQuery({ stage: 'SIGNED' }, { id: 1, role: 'DIRECTOR' });
    const rSigned = (await db.query(`SELECT public.fn_query_leads_unified($1::jsonb, $2::jsonb) AS res`, [JSON.stringify(qSigned.dbFilters), JSON.stringify(qSigned.dbScope)])).rows[0].res;
    expect(rSigned.total).toBe(1);
    expect(rSigned.leads[0].id).toBe(2);

    // Check Asia/Dushanbe [from, to): 2026-11-25 22:00 UTC is 2026-11-26 03:00 Dushanbe -> excluded from createdTo=2026-11-25
    const qNov25 = validateAndNormalizeLeadQuery({ createdFrom: '2026-11-25', createdTo: '2026-11-25' }, { id: 1, role: 'DIRECTOR' });
    const rNov25 = (await db.query(`SELECT public.fn_query_leads_unified($1::jsonb, $2::jsonb) AS res`, [JSON.stringify(qNov25.dbFilters), JSON.stringify(qNov25.dbScope)])).rows[0].res;
    expect(rNov25.leads.map((l) => l.id).sort()).toEqual([2, 3]);

    // Check NO_TASK vs PAUSED distinction
    const qPaused = validateAndNormalizeLeadQuery({ taskState: 'PAUSED' }, { id: 1, role: 'DIRECTOR' });
    const rPaused = (await db.query(`SELECT public.fn_query_leads_unified($1::jsonb, $2::jsonb) AS res`, [JSON.stringify(qPaused.dbFilters), JSON.stringify(qPaused.dbScope)])).rows[0].res;
    expect(rPaused.leads.map((l) => l.id)).toEqual([3]);

    // Check SALES_MANAGER scope: even with managerId=ALL, Rep A (id=2) cannot see Rep B's Lead 2
    const qMgr = validateAndNormalizeLeadQuery({ managerId: 'ALL' }, { id: 2, role: 'SALES_MANAGER', all_projects_access: true });
    const rMgr = (await db.query(`SELECT public.fn_query_leads_unified($1::jsonb, $2::jsonb) AS res`, [JSON.stringify(qMgr.dbFilters), JSON.stringify(qMgr.dbScope)])).rows[0].res;
    expect(rMgr.leads.map((l) => l.id).sort()).toEqual([1, 3]);
    expect(rMgr.total).toBe(2);
  }, 30000);

  it('rejects unsupported filter keys, unknown stage/taskState, and mismatched/corrupt cursor with 400', () => {
    const user = { id: 1, role: 'DIRECTOR' };
    expect(() => validateAndNormalizeLeadQuery({ unknownParam: '1' }, user)).toThrow(/Неподдерживаемый параметр/);
    expect(() => validateAndNormalizeLeadQuery({ stage: 'BOGUS' }, user)).toThrow(/Неизвестный этап/);
    expect(() => validateAndNormalizeLeadQuery({ taskState: 'BOGUS' }, user)).toThrow(/Неизвестное состояние/);
    expect(() => validateAndNormalizeLeadQuery({ cursor: 'not-valid-base64' }, user)).toThrow(/Некорректный курсор/);

    const q1 = validateAndNormalizeLeadQuery({ stage: 'NEW' }, user);
    const c1 = encodeLeadCursor({ id: 5, created_at: '2026-11-25T10:00:00.000Z' }, q1.filterHash);
    expect(() => validateAndNormalizeLeadQuery({ stage: 'LOST', cursor: c1 }, user)).toThrow(/не соответствует текущему набору фильтров/);
  });

  it('R04.1: preserves exact microsecond cursor boundaries (same millisecond, different microseconds)', async () => {
    const db = await setupDbWith064();
    await db.query(
      `INSERT INTO public.leads (id, full_name, phone, status, stage, responsible_user_id, interested_project_id, created_at)
       VALUES
         (101, 'Us 1', '+992900001101', 'NEW', 'NEW', 2, 1, '2026-11-25T10:00:10.123456+00:00'),
         (102, 'Us 2', '+992900001102', 'NEW', 'NEW', 2, 1, '2026-11-25T10:00:10.123455+00:00'),
         (103, 'Us 3', '+992900001103', 'NEW', 'NEW', 2, 1, '2026-11-25T10:00:10.123454+00:00'),
         (104, 'Us 4', '+992900001104', 'NEW', 'NEW', 2, 1, '2026-11-25T10:00:10.123454+00:00')`
    );

    const user = { id: 1, role: 'DIRECTOR' };
    const q1 = validateAndNormalizeLeadQuery({ limit: '2' }, user);
    const r1 = (await db.query(`SELECT public.fn_query_leads_unified($1::jsonb, $2::jsonb) AS res`, [JSON.stringify(q1.dbFilters), JSON.stringify(q1.dbScope)])).rows[0].res;
    expect(r1.leads.map((l) => l.id)).toEqual([101, 102]);
    expect(r1.leads[1].created_at_iso_us).toBe('2026-11-25T10:00:10.123455Z');

    const cursor = encodeLeadCursor(r1.leads[1], q1.filterHash);
    const q2 = validateAndNormalizeLeadQuery({ limit: '2', cursor }, user);
    expect(q2.dbFilters.cursor_created_at).toBe('2026-11-25T10:00:10.123455Z');

    const r2 = (await db.query(`SELECT public.fn_query_leads_unified($1::jsonb, $2::jsonb) AS res`, [JSON.stringify(q2.dbFilters), JSON.stringify(q2.dbScope)])).rows[0].res;
    expect(r2.leads.map((l) => l.id)).toEqual([104, 103]);
  });

  it('R04.1: loads independent board_columns per stage even when NEW has >page rows', async () => {
    const db = await setupDbWith064();
    for (let i = 1; i <= 25; i += 1) {
      await db.query(
        `INSERT INTO public.leads (id, full_name, phone, status, stage, responsible_user_id, interested_project_id, created_at)
         VALUES ($1, $2, $3, 'NEW', 'NEW', 2, 1, $4)`,
        [i, `New ${i}`, `+99290001${String(i).padStart(4, '0')}`, new Date(Date.UTC(2026, 10, 25, 12, i, 0)).toISOString()]
      );
    }
    await db.query(
      `INSERT INTO public.leads (id, full_name, phone, status, stage, responsible_user_id, interested_project_id, created_at)
       VALUES
         (201, 'Reserved Lead', '+992900090201', 'NEW', 'RESERVED', 2, 1, '2026-11-25T10:00:00Z'),
         (202, 'Lost Lead', '+992900090202', 'LOST', 'LOST', 2, 1, '2026-11-25T09:00:00Z')`
    );

    const user = { id: 1, role: 'DIRECTOR' };
    const q = validateAndNormalizeLeadQuery({ limit: '0', boardPerStageLimit: '10' }, user);
    const res = (await db.query(`SELECT public.fn_query_leads_unified($1::jsonb, $2::jsonb) AS res`, [JSON.stringify(q.dbFilters), JSON.stringify(q.dbScope)])).rows[0].res;

    expect(res.total).toBe(27);
    expect(res.board_columns.NEW.leads).toHaveLength(10);
    expect(res.board_columns.NEW.total).toBe(25);
    expect(res.board_columns.RESERVED.leads.map((l) => l.id)).toEqual([201]);
    expect(res.board_columns.LOST.leads.map((l) => l.id)).toEqual([202]);
  });

  it('R04.1: fails closed on empty/missing project permissions for restricted user and enforces allowed_project_ids', async () => {
    const db = await setupDbWith064();
    await db.query(
      `INSERT INTO public.leads (id, full_name, phone, status, stage, responsible_user_id, interested_project_id, created_at)
       VALUES
         (301, 'Proj 1 Lead', '+992900080301', 'NEW', 'NEW', 2, 1, '2026-11-25T10:00:00Z'),
         (302, 'Proj 2 Lead', '+992900080302', 'NEW', 'NEW', 2, 2, '2026-11-25T10:01:00Z')`
    );

    // Restricted user with empty allowed_project_ids -> must see 0 rows (NOT all projects!)
    const emptyScopeUser = { id: 2, role: 'SALES_MANAGER', allowed_project_ids: [] };
    const qEmpty = validateAndNormalizeLeadQuery({}, emptyScopeUser);
    expect(qEmpty.dbScope.has_all_projects).toBe(false);
    const rEmpty = (await db.query(`SELECT public.fn_query_leads_unified($1::jsonb, $2::jsonb) AS res`, [JSON.stringify(qEmpty.dbFilters), JSON.stringify(qEmpty.dbScope)])).rows[0].res;
    expect(rEmpty.total).toBe(0);
    expect(rEmpty.leads).toEqual([]);

    // Restricted user with missing/unknown project scope -> must also fail closed (0 rows)
    const unknownScopeUser = { id: 2, role: 'SALES_MANAGER' };
    const qUnknown = validateAndNormalizeLeadQuery({}, unknownScopeUser);
    expect(qUnknown.dbScope.has_all_projects).toBe(false);
    const rUnknown = (await db.query(`SELECT public.fn_query_leads_unified($1::jsonb, $2::jsonb) AS res`, [JSON.stringify(qUnknown.dbFilters), JSON.stringify(qUnknown.dbScope)])).rows[0].res;
    expect(rUnknown.total).toBe(0);
    expect(rUnknown.leads).toEqual([]);

    // Restricted user with explicit allowed_project_ids: [1] -> sees only project 1, never project 2
    const proj1User = { id: 2, role: 'SALES_MANAGER', allowed_project_ids: [1] };
    const qProj1 = validateAndNormalizeLeadQuery({}, proj1User);
    const rProj1 = (await db.query(`SELECT public.fn_query_leads_unified($1::jsonb, $2::jsonb) AS res`, [JSON.stringify(qProj1.dbFilters), JSON.stringify(qProj1.dbScope)])).rows[0].res;
    expect(rProj1.total).toBe(1);
    expect(rProj1.leads.map((l) => l.id)).toEqual([301]);
  });
});
