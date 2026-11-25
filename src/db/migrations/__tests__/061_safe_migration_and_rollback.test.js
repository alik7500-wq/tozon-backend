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
    VALUES (50, 'Existing Lead', '+992900000050', 'NEW');
  `);
  return db;
}

describe('R02: Safe Migration 061, Overload EXECUTE Hardening, and Data-Preserving App Rollback', () => {
  it('applies 060+061 idempotently, blocks anon/authenticated on ALL overloads, allows service_role, and preserves data on app rollback', async () => {
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

    // 2. Verify only the unified 7-arg (DEFAULT NULL) function remains, eliminating ambiguity,
    //    and PUBLIC/anon/authenticated CANNOT execute 6-arg or 7-arg calls
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
       VALUES (51, 1, 'Post-Upgrade Lead', NULL, 'NEW', 'MEETING_SCHEDULED')`
    );
    await db.query(
      `INSERT INTO public.lead_communications (lead_id, channel, direction, event_type)
       VALUES (51, 'INSTAGRAM', 'INBOUND', 'INBOUND_MESSAGE')`
    );
    await db.query(
      `INSERT INTO public.crm_event_outbox (event_type, aggregate_type, aggregate_id, idempotency_key)
       VALUES ('LEAD_CREATED', 'lead', '51', 'evt_51')`
    );

    // 5. Run safe data-preserving app rollback
    await db.exec(sqlAppRollback);

    const postRollbackLead = await db.query(`SELECT status, stage, phone FROM public.leads WHERE id = 51`);
    expect(postRollbackLead.rows[0].status).toBe('NEGOTIATION'); // Compatible with old app
    expect(postRollbackLead.rows[0].stage).toBe('MEETING_SCHEDULED'); // New data preserved
    expect(postRollbackLead.rows[0].phone).toBeNull();

    const preservedCounts = await db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM public.contacts) AS contacts_cnt,
        (SELECT COUNT(*)::int FROM public.lead_communications) AS comms_cnt,
        (SELECT COUNT(*)::int FROM public.crm_event_outbox) AS outbox_cnt
    `);
    expect(preservedCounts.rows[0]).toEqual({ contacts_cnt: 1, comms_cnt: 1, outbox_cnt: 1 });

    // 6. Verify destructive rollback_060 refuses to run without explicit test-only guard
    await expect(db.exec(sqlDestructive)).rejects.toThrow(/DESTRUCTIVE_ROLLBACK_BLOCKED/);
  }, 30000);
});
