import { describe, it, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

async function createDbWith062() {
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
      phone TEXT,
      status TEXT NOT NULL DEFAULT 'NEW',
      responsible_user_id BIGINT REFERENCES public.users(id),
      interested_project_id BIGINT,
      assigned_at TIMESTAMPTZ,
      reassignment_reason TEXT,
      lost_reason TEXT,
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

    INSERT INTO public.users (id, name, role, is_active, is_sales_rep)
    VALUES (1, 'Director', 'DIRECTOR', 1, false), (2, 'Rep A', 'SALES_MANAGER', 1, true), (3, 'Rep B', 'SALES_MANAGER', 1, true);

    INSERT INTO public.leads (id, full_name, phone, status)
    VALUES
      (10, 'Concurrent Stage Lead', '+992900000010', 'NEW'),
      (11, 'Signed Buyer Lead', '+992900000011', 'WON');

    INSERT INTO public.deals (id, lead_id, unit_id, responsible_user_id, status)
    VALUES (1, 11, 101, 2, 'SIGNED');
  `);

  await db.exec(readFileSync('src/db/migrations/060_crm_sales_completion_foundation.sql', 'utf8'));
  await db.exec(readFileSync('src/db/migrations/061_harden_fn_assign_lead_atomic_and_app_rollback.sql', 'utf8'));
  await db.exec(readFileSync('src/db/migrations/062_atomic_lead_stage_transition.sql', 'utf8'));
  return db;
}

describe('R03: Atomic Lead Stage Transition (fn_update_lead_stage_atomic + fail-closed repository)', () => {
  it('enforces single winner on two concurrent stage transitions with same version, no duplicate history/outbox, and no fabricated contact', async () => {
    const db = await createDbWith062();

    const [r1, r2] = await Promise.all([
      db.query(`SELECT public.fn_update_lead_stage_atomic(10, 'IN_PROGRESS', NULL, NULL, 2, 1, 'idem-1') AS res`),
      db.query(`SELECT public.fn_update_lead_stage_atomic(10, 'NEGOTIATION', NULL, NULL, 3, 1, 'idem-2') AS res`)
    ]);

    const results = [r1.rows[0].res, r2.rows[0].res];
    const winners = results.filter((r) => r.success === true && r.status === 'UPDATED');
    const conflicts = results.filter((r) => r.success === false && r.error_code === 'VERSION_CONFLICT');

    expect(winners).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].status_code).toBe(409);
    expect(conflicts[0].current_version).toBe(2);

    const leadRow = await db.query(`SELECT version, stage, first_human_action_at, first_response_at, first_contact_confirmed_at FROM public.leads WHERE id = 10`);
    expect(leadRow.rows[0].version).toBe(2);
    expect(leadRow.rows[0].first_human_action_at).toBeNull();
    expect(leadRow.rows[0].first_response_at).toBeNull();
    expect(leadRow.rows[0].first_contact_confirmed_at).toBeNull();

    const histCount = await db.query(`SELECT COUNT(*)::int AS cnt FROM public.lead_stage_history WHERE lead_id = 10`);
    const outboxCount = await db.query(`SELECT COUNT(*)::int AS cnt FROM public.crm_event_outbox WHERE aggregate_id = '10'`);
    expect(histCount.rows[0].cnt).toBe(1);
    expect(outboxCount.rows[0].cnt).toBe(1);
  }, 30000);

  it('prevents concurrent stage transition and manager assignment from overwriting each other', async () => {
    const db = await createDbWith062();

    const [stageRes, assignRes] = await Promise.all([
      db.query(`SELECT public.fn_update_lead_stage_atomic(10, 'IN_PROGRESS', NULL, NULL, 1, 1, NULL) AS res`),
      db.query(`SELECT public.fn_assign_lead_atomic(10, 2, 1, 'Назначение', 25, true, 1) AS res`)
    ]);

    const outcomes = [stageRes.rows[0].res, assignRes.rows[0].res];
    expect(outcomes.filter((o) => o.success === true)).toHaveLength(1);
    expect(outcomes.filter((o) => o.success === false && o.error_code === 'VERSION_CONFLICT')).toHaveLength(1);
  }, 30000);

  it('replays idempotent repeat without duplicating effects and rejects conflicting payload with same key', async () => {
    const db = await createDbWith062();

    const first = await db.query(`SELECT public.fn_update_lead_stage_atomic(10, 'IN_PROGRESS', NULL, NULL, 2, 1, 'key-abc') AS res`);
    expect(first.rows[0].res.success).toBe(true);
    expect(first.rows[0].res.replayed).toBe(false);
    expect(first.rows[0].res.version).toBe(2);

    const replay = await db.query(`SELECT public.fn_update_lead_stage_atomic(10, 'IN_PROGRESS', NULL, NULL, 2, 1, 'key-abc') AS res`);
    expect(replay.rows[0].res.success).toBe(true);
    expect(replay.rows[0].res.replayed).toBe(true);
    expect(replay.rows[0].res.version).toBe(2);

    const conflict = await db.query(`SELECT public.fn_update_lead_stage_atomic(10, 'NEGOTIATION', NULL, NULL, 2, 2, 'key-abc') AS res`);
    expect(conflict.rows[0].res.success).toBe(false);
    expect(conflict.rows[0].res.error_code).toBe('IDEMPOTENCY_CONFLICT');
    expect(conflict.rows[0].res.status_code).toBe(409);

    const histCount = await db.query(`SELECT COUNT(*)::int AS cnt FROM public.lead_stage_history WHERE lead_id = 10`);
    expect(histCount.rows[0].cnt).toBe(1);
  }, 30000);

  it('rolls back leads UPDATE if history INSERT or outbox INSERT fails', async () => {
    const db = await createDbWith062();

    // 1. Trigger failure on lead_stage_history
    await db.exec(`
      CREATE OR REPLACE FUNCTION public.fail_history() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'SIMULATED_HISTORY_FAILURE'; END; $$;
      CREATE TRIGGER trg_fail_history BEFORE INSERT ON public.lead_stage_history FOR EACH ROW EXECUTE FUNCTION public.fail_history();
    `);
    await expect(
      db.query(`SELECT public.fn_update_lead_stage_atomic(10, 'IN_PROGRESS', NULL, NULL, 2, 1, NULL)`)
    ).rejects.toThrow(/SIMULATED_HISTORY_FAILURE/);

    const afterHistFail = await db.query(`SELECT stage, version FROM public.leads WHERE id = 10`);
    expect(afterHistFail.rows[0]).toEqual({ stage: 'NEW', version: 1 });

    // 2. Drop history trigger, add outbox failure trigger
    await db.exec(`
      DROP TRIGGER trg_fail_history ON public.lead_stage_history;
      CREATE OR REPLACE FUNCTION public.fail_outbox() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'SIMULATED_OUTBOX_FAILURE'; END; $$;
      CREATE TRIGGER trg_fail_outbox BEFORE INSERT ON public.crm_event_outbox FOR EACH ROW EXECUTE FUNCTION public.fail_outbox();
    `);
    await expect(
      db.query(`SELECT public.fn_update_lead_stage_atomic(10, 'IN_PROGRESS', NULL, NULL, 2, 1, NULL)`)
    ).rejects.toThrow(/SIMULATED_OUTBOX_FAILURE/);

    const afterOutboxFail = await db.query(`SELECT stage, version FROM public.leads WHERE id = 10`);
    const histAfterOutboxFail = await db.query(`SELECT COUNT(*)::int AS cnt FROM public.lead_stage_history WHERE lead_id = 10`);
    expect(afterOutboxFail.rows[0]).toEqual({ stage: 'NEW', version: 1 });
    expect(histAfterOutboxFail.rows[0].cnt).toBe(0);
  }, 30000);

  it('blocks forbidden transitions (SIGNED read-only, manual SIGNED, LOST without reason) and anon/authenticated EXECUTE', async () => {
    const db = await createDbWith062();

    const signedEdit = await db.query(`SELECT public.fn_update_lead_stage_atomic(11, 'NEGOTIATION', NULL, 'откат', 1, 1, NULL) AS res`);
    expect(signedEdit.rows[0].res.error_code).toBe('SIGNED_READ_ONLY');

    const manualSigned = await db.query(`SELECT public.fn_update_lead_stage_atomic(10, 'SIGNED', NULL, NULL, 1, 1, NULL) AS res`);
    expect(manualSigned.rows[0].res.error_code).toBe('SIGNED_REQUIRES_DEAL');

    const lostNoReason = await db.query(`SELECT public.fn_update_lead_stage_atomic(10, 'LOST', NULL, NULL, 1, 1, NULL) AS res`);
    expect(lostNoReason.rows[0].res.error_code).toBe('LOST_REASON_REQUIRED');

    await db.exec('SET ROLE anon;');
    await expect(
      db.query(`SELECT public.fn_update_lead_stage_atomic(10, 'IN_PROGRESS', NULL, NULL, 1, 1, NULL)`)
    ).rejects.toThrow(/permission denied/i);
    await db.exec('RESET ROLE;');
  }, 30000);
});
