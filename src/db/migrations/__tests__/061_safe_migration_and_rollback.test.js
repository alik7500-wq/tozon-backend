import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

async function setupWithLegacy052() {
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

    CREATE TABLE public.deals (
      id BIGSERIAL PRIMARY KEY,
      lead_id BIGINT NOT NULL REFERENCES public.leads(id),
      unit_id BIGINT NOT NULL,
      responsible_user_id BIGINT NOT NULL REFERENCES public.users(id),
      status TEXT NOT NULL DEFAULT 'DRAFT'
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

    -- Legacy 6-arg function from migration 052 (which had default PUBLIC EXECUTE)
    CREATE OR REPLACE FUNCTION public.fn_assign_lead_atomic(
      p_lead_id BIGINT, p_target_user_id BIGINT, p_actor_user_id BIGINT,
      p_reason TEXT, p_max_capacity INT DEFAULT 25, p_is_manual BOOLEAN DEFAULT FALSE
    ) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN
      RETURN jsonb_build_object('success', true, 'legacy', true);
    END;
    $$;

    INSERT INTO public.users (id, name, role, is_active, is_sales_rep)
    VALUES (1, 'Director', 'DIRECTOR', 1, false), (2, 'Rep A', 'SALES_MANAGER', 1, true), (3, 'Rep B', 'SALES_MANAGER', 1, true);

    INSERT INTO public.leads (id, full_name, phone, status)
    VALUES
      (50, 'Legacy WON No Deal', '+992900000050', 'WON'),
      (51, 'Confirmed Signed Buyer', '+992900000051', 'WON'),
      (52, 'Reserved Only', '+992900000052', 'NEGOTIATION'),
      (53, 'Draft Only', '+992900000053', 'NEGOTIATION'),
      (54, 'Two Deals One Cancelled', '+992900000054', 'WON'),
      (55, 'Single Deal Cancelled', '+992900000055', 'WON');

    INSERT INTO public.deals (id, lead_id, unit_id, responsible_user_id, status)
    VALUES
      (1, 51, 101, 2, 'SIGNED'),
      (2, 52, 102, 2, 'RESERVED'),
      (3, 53, 103, 2, 'DRAFT'),
      (4, 54, 104, 2, 'CANCELLED'),
      (5, 54, 105, 2, 'SIGNED'),
      (6, 55, 106, 2, 'CANCELLED');
  `);
  return db;
}

describe('R02 & R02.1: Safe Migration 061, Overload EXECUTE Hardening, and Deal-Authoritative App Rollback', () => {
  it('verifies legacy WON + signed deal chain through 060 -> 061 -> idempotent app rollback, preserving all data and RBAC', async () => {
    const db = await setupWithLegacy052();
    const sql060 = readFileSync('src/db/migrations/060_crm_sales_completion_foundation.sql', 'utf8');
    const sql061 = readFileSync('src/db/migrations/061_harden_fn_assign_lead_atomic_and_app_rollback.sql', 'utf8');
    const sqlAppRollback = readFileSync('src/db/migrations/app_rollback_060_061_preserve_data.sql', 'utf8');
    const sqlDestructive = readFileSync('src/db/migrations/rollback_060_crm_sales_completion_foundation.sql', 'utf8');

    // 1. Apply 060 + 061 twice (idempotency)
    await db.exec(sql060);
    await db.exec(sql061);
    await db.exec(sql060);
    await db.exec(sql061);

    // 2. Verify only the unified 7-arg (DEFAULT NULL) function remains and anon/authenticated CANNOT execute
    const overloads = await db.query(`
      SELECT p.oid::regprocedure::text AS sig, p.pronargs
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'fn_assign_lead_atomic'
      ORDER BY p.pronargs
    `);
    expect(overloads.rows.map((r) => r.pronargs)).toEqual([7]);

    for (const forbiddenRole of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${forbiddenRole};`);
      await expect(
        db.query(`SELECT public.fn_assign_lead_atomic(50::bigint, 2::bigint, 1::bigint, 'hack', 25, true)`)
      ).rejects.toThrow(/permission denied/i);
      await expect(
        db.query(`SELECT public.fn_assign_lead_atomic(50::bigint, 2::bigint, 1::bigint, 'hack', 25, true, 1)`)
      ).rejects.toThrow(/permission denied/i);
      await db.exec('RESET ROLE;');
    }

    // 3. Verify service_role CAN execute both 7-arg (new app) and 6-arg (old app) calls
    await db.exec('SET ROLE service_role;');
    const res7 = await db.query(
      `SELECT public.fn_assign_lead_atomic(50::bigint, 2::bigint, 1::bigint, 'New app assign', 25, true, 1) AS res`
    );
    expect(res7.rows[0].res.success).toBe(true);
    expect(res7.rows[0].res.version).toBe(2);

    const res6 = await db.query(
      `SELECT public.fn_assign_lead_atomic(50::bigint, 3::bigint, 1::bigint, 'Old app assign', 25, true) AS res`
    );
    expect(res6.rows[0].res.success).toBe(true);
    expect(res6.rows[0].res.version).toBe(3);
    await db.exec('RESET ROLE;');

    // 4. Create post-upgrade data (contact, NULL-phone lead on new stage, communication, outbox)
    await db.query(`INSERT INTO public.contacts (id, full_name, phone) VALUES (1, 'New Contact', NULL)`);
    await db.query(
      `INSERT INTO public.leads (id, contact_id, full_name, phone, status, stage)
       VALUES (56, 1, 'Post-Upgrade Meeting Lead', NULL, 'NEW', 'MEETING_SCHEDULED')`
    );
    await db.query(
      `INSERT INTO public.lead_communications (lead_id, channel, direction, event_type)
       VALUES (56, 'INSTAGRAM', 'INBOUND', 'INBOUND_MESSAGE')`
    );
    await db.query(
      `INSERT INTO public.crm_event_outbox (event_type, aggregate_type, aggregate_id, idempotency_key)
       VALUES ('LEAD_CREATED', 'lead', '56', 'evt_56')`
    );

    // 5. Run safe deal-authoritative app rollback TWICE (idempotency)
    await db.exec(sqlAppRollback);
    await db.exec(sqlAppRollback);

    const leadsAfter = await db.query(`SELECT id, status, stage, phone FROM public.leads ORDER BY id`);
    const byId = Object.fromEntries(leadsAfter.rows.map((r) => [Number(r.id), r]));

    // Legacy WON without signed deal must NOT remain/become confirmed sale
    expect(byId[50].stage).toBe('CONTRACT_PREP');
    expect(byId[50].status).toBe('NEGOTIATION');

    // Confirmed SIGNED deal preserves confirmed sale
    expect(byId[51].status).toBe('WON');

    // Reserved & Draft never become WON
    expect(byId[52].status).toBe('NEGOTIATION');
    expect(byId[53].status).toBe('NEGOTIATION');

    // Cancelled + another SIGNED deal -> stays WON
    expect(byId[54].status).toBe('WON');

    // Cancelled only (no remaining SIGNED deal) -> does not stay WON
    expect(byId[55].status).toBe('NEGOTIATION');

    // Post-upgrade NULL-phone lead keeps data and aligns status for old app
    expect(byId[56].status).toBe('NEGOTIATION');
    expect(byId[56].stage).toBe('MEETING_SCHEDULED');
    expect(byId[56].phone).toBeNull();

    const preservedCounts = await db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM public.contacts) AS contacts_cnt,
        (SELECT COUNT(*)::int FROM public.lead_communications) AS comms_cnt,
        (SELECT COUNT(*)::int FROM public.crm_event_outbox) AS outbox_cnt,
        (SELECT COUNT(*)::int FROM public.deals) AS deals_cnt
    `);
    expect(preservedCounts.rows[0]).toEqual({ contacts_cnt: 1, comms_cnt: 1, outbox_cnt: 1, deals_cnt: 6 });

    // 6. Verify destructive rollback_060 refuses to run without explicit test-only guard
    await expect(db.exec(sqlDestructive)).rejects.toThrow(/DESTRUCTIVE_ROLLBACK_BLOCKED/);
  }, 30000);

  it('aborts and rolls back transaction in 061 if 7-arg overload lacks DEFAULTs or safe search_path (no CASCADE drop)', async () => {
    const db = await setupWithLegacy052();
    const sql061 = readFileSync('src/db/migrations/061_harden_fn_assign_lead_atomic_and_app_rollback.sql', 'utf8');

    // Create an incompatible 7-arg overload WITHOUT defaults and WITHOUT search_path
    await db.exec(`
      CREATE FUNCTION public.fn_assign_lead_atomic(
        BIGINT, BIGINT, BIGINT, TEXT, INT, BOOLEAN, INT
      ) RETURNS JSONB LANGUAGE plpgsql AS $$
      BEGIN RETURN '{}'::jsonb; END; $$;
    `);

    await expect(db.exec(sql061)).rejects.toThrow(/INCOMPATIBLE_FN_ASSIGN_LEAD_ATOMIC_SIGNATURE|current transaction is aborted/);
    await db.exec('ROLLBACK;').catch(() => {});

    // Verify legacy 6-arg overload was NOT dropped because the transaction rolled back
    const remaining = await db.query(`
      SELECT p.pronargs FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'fn_assign_lead_atomic'
      ORDER BY p.pronargs
    `);
    expect(remaining.rows.map((r) => r.pronargs)).toEqual([6, 7]);
  }, 30000);
});
