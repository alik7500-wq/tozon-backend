import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

async function setupPre060Db() {
  const db = new PGlite();
  await db.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
    END $$;

    CREATE TABLE public.users (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'SALES_MANAGER',
      is_active INT NOT NULL DEFAULT 1,
      is_sales_rep BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE TABLE public.leads (
      id BIGSERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'NEW',
      responsible_user_id BIGINT REFERENCES public.users(id),
      interested_project_id BIGINT,
      assigned_at TIMESTAMPTZ,
      reassignment_reason TEXT,
      created_at TEXT NOT NULL DEFAULT NOW()::TEXT,
      updated_at TEXT NOT NULL DEFAULT NOW()::TEXT,
      archived_at TEXT
    );

    CREATE TABLE public.tasks (
      id BIGSERIAL PRIMARY KEY,
      lead_id BIGINT REFERENCES public.leads(id),
      deal_id BIGINT,
      assigned_user_id BIGINT,
      created_by BIGINT,
      type TEXT NOT NULL DEFAULT 'CALL',
      priority TEXT DEFAULT 'NORMAL',
      title TEXT NOT NULL,
      description TEXT,
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'OPEN',
      idempotency_key VARCHAR(255)
    );

    CREATE UNIQUE INDEX uq_tasks_open_lead_call
      ON public.tasks(lead_id, type)
      WHERE status = 'OPEN' AND lead_id IS NOT NULL AND type = 'CALL';

    CREATE TABLE public.lead_assignment_history (
      id BIGSERIAL PRIMARY KEY,
      lead_id BIGINT NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
      from_user_id BIGINT REFERENCES public.users(id),
      to_user_id BIGINT REFERENCES public.users(id),
      assigned_by_user_id BIGINT REFERENCES public.users(id),
      assignment_type VARCHAR(50) NOT NULL DEFAULT 'MANUAL',
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE public.lead_distribution_settings (
      id BIGSERIAL PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      algorithm VARCHAR(50) NOT NULL DEFAULT 'LEAST_LOADED',
      max_open_leads_per_rep INTEGER NOT NULL DEFAULT 25,
      excluded_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      working_hours_only BOOLEAN NOT NULL DEFAULT TRUE,
      auto_reassign_on_stagnant BOOLEAN NOT NULL DEFAULT FALSE,
      updated_by_user_id BIGINT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO public.users (id, name, role, is_active, is_sales_rep)
    VALUES (1, 'Admin', 'ADMIN', 1, false), (2, 'Manager A', 'SALES_MANAGER', 1, true), (3, 'Manager B', 'SALES_MANAGER', 1, true);

    INSERT INTO public.leads (id, full_name, phone, status)
    VALUES (10, 'Legacy Won', '+992900000001', 'WON'), (11, 'New Lead', '+992900000002', 'NEW');
  `);
  return db;
}

describe('Migration 060 CRM Sales Completion Foundation (PGlite)', () => {
  it('applies idempotently, preserves legacy WON, allows NULL phone & multiple CALL tasks, enforces CAS 409, and rolls back cleanly', async () => {
    const db = await setupPre060Db();
    const sql060 = readFileSync('src/db/migrations/060_crm_sales_completion_foundation.sql', 'utf8');
    const sqlRollback = readFileSync('src/db/migrations/rollback_060_crm_sales_completion_foundation.sql', 'utf8');

    // Apply twice to verify idempotency
    await db.exec(sql060);
    await db.exec(sql060);

    // 1. Legacy WON must NOT become SIGNED
    const legacy = await db.query('SELECT status, stage FROM public.leads WHERE id = 10');
    expect(legacy.rows[0].stage).toBe('CONTRACT_PREP');
    expect(legacy.rows[0].stage).not.toBe('SIGNED');

    // 2. Phone-optional lead (A08)
    const noPhone = await db.query(
      `INSERT INTO public.leads (full_name, phone, status, stage) VALUES ('Instagram User', NULL, 'NEW', 'NEW') RETURNING id, phone`
    );
    expect(noPhone.rows[0].phone).toBeNull();

    // 3. Multiple legitimate future CALL tasks allowed (F-13.7)
    await db.query(
      `INSERT INTO public.tasks (lead_id, type, title, status, due_at, idempotency_key)
       VALUES (11, 'CALL', 'Первичный звонок', 'OPEN', NOW() + interval '15 minutes', 'evt-1'),
              (11, 'CALL', 'Согласованный перезвон', 'OPEN', NOW() + interval '2 hours', 'evt-2')`
    );
    const callCount = await db.query(`SELECT COUNT(*)::int AS cnt FROM public.tasks WHERE lead_id = 11 AND type = 'CALL'`);
    expect(callCount.rows[0].cnt).toBe(2);

    // 4. CAS version conflict on fn_assign_lead_atomic (A11 / F-09)
    const assign1 = await db.query(`SELECT public.fn_assign_lead_atomic(11, 2, 1, 'Первичное назначение', 25, true, 1) AS res`);
    expect(assign1.rows[0].res.success).toBe(true);
    expect(assign1.rows[0].res.version).toBe(2);

    const staleAssign = await db.query(`SELECT public.fn_assign_lead_atomic(11, 3, 1, 'Устаревшая версия', 25, true, 1) AS res`);
    expect(staleAssign.rows[0].res.success).toBe(false);
    expect(staleAssign.rows[0].res.error_code).toBe('VERSION_CONFLICT');
    expect(staleAssign.rows[0].res.current_version).toBe(2);

    // 5. RLS/GRANT check for anon/authenticated
    const grants = await db.query(`
      SELECT grantee, table_name FROM information_schema.role_table_grants
      WHERE table_schema = 'public'
        AND table_name IN ('contacts', 'lead_communications', 'crm_event_outbox', 'crm_automation_rules', 'call_ai_analyses')
        AND grantee IN ('anon', 'authenticated')
    `);
    expect(grants.rows).toHaveLength(0);

    // 6. Clean destructive rollback ONLY on disposable test DB with explicit guard flag (A51)
    await db.exec(`BEGIN; SET LOCAL tozon.allow_destructive_test_cleanup = 'YES_TEST_ONLY'; COMMIT;`);
    await db.exec(`SET tozon.allow_destructive_test_cleanup = 'YES_TEST_ONLY';\n${sqlRollback}`);
    const remaining = await db.query(`
      SELECT to_regclass('public.contacts') AS c, to_regclass('public.crm_event_outbox') AS o
    `);
    expect(remaining.rows[0].c).toBeNull();
    expect(remaining.rows[0].o).toBeNull();
  }, 30000);
});
