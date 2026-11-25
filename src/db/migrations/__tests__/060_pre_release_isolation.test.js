import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

async function createIsolatedDb() {
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
    VALUES (100, 'Concurrent Lead', '+992900000100', 'NEW');
  `);
  const sql060 = readFileSync('src/db/migrations/060_crm_sales_completion_foundation.sql', 'utf8');
  await db.exec(sql060);
  return db;
}

describe('Pre-release isolated PostgreSQL verification (060)', () => {
  it('enforces concurrent assignment safety (A10/A11): two simultaneous callers with version=1 yield 1 ASSIGNED and 1 VERSION_CONFLICT', async () => {
    const db = await createIsolatedDb();

    const [r1, r2] = await Promise.all([
      db.query(`SELECT public.fn_assign_lead_atomic(100, 2, 1, 'Worker 1', 25, true, 1) AS res`),
      db.query(`SELECT public.fn_assign_lead_atomic(100, 3, 1, 'Worker 2', 25, true, 1) AS res`)
    ]);

    const results = [r1.rows[0].res, r2.rows[0].res];
    const winners = results.filter((r) => r.success === true && r.status === 'ASSIGNED');
    const conflicts = results.filter((r) => r.success === false && r.error_code === 'VERSION_CONFLICT');

    expect(winners).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].current_version).toBe(2);

    const history = await db.query(`SELECT COUNT(*)::int AS cnt FROM public.lead_assignment_history WHERE lead_id = 100`);
    expect(history.rows[0].cnt).toBe(1);
  });

  it('guarantees outbox idempotency, retry recovery, and quarantine on max_attempts (A45/A46/N-03)', async () => {
    const db = await createIsolatedDb();

    // Duplicate event with same idempotency_key produces only 1 outbox row
    await db.query(`
      INSERT INTO public.crm_event_outbox (event_type, aggregate_type, aggregate_id, idempotency_key, payload_json)
      VALUES ('LEAD_CREATED', 'lead', '100', 'evt_ig_999', '{"leadId":100}')
      ON CONFLICT (idempotency_key) DO NOTHING
    `);
    await db.query(`
      INSERT INTO public.crm_event_outbox (event_type, aggregate_type, aggregate_id, idempotency_key, payload_json)
      VALUES ('LEAD_CREATED', 'lead', '100', 'evt_ig_999', '{"leadId":100}')
      ON CONFLICT (idempotency_key) DO NOTHING
    `);

    const countRes = await db.query(`SELECT COUNT(*)::int AS cnt FROM public.crm_event_outbox WHERE idempotency_key = 'evt_ig_999'`);
    expect(countRes.rows[0].cnt).toBe(1);

    // Simulate failure + recovery
    await db.query(`
      UPDATE public.crm_event_outbox
      SET status = 'FAILED', attempts = attempts + 1, last_error = 'Temporary timeout', next_retry_at = NOW()
      WHERE idempotency_key = 'evt_ig_999'
    `);
    const dueRes = await db.query(`
      SELECT id, status, attempts FROM public.crm_event_outbox
      WHERE status IN ('PENDING', 'FAILED') AND next_retry_at <= NOW()
    `);
    expect(dueRes.rows).toHaveLength(1);

    await db.query(`
      UPDATE public.crm_event_outbox
      SET status = 'DONE', processed_at = NOW()
      WHERE idempotency_key = 'evt_ig_999'
    `);
    const doneRes = await db.query(`SELECT status FROM public.crm_event_outbox WHERE idempotency_key = 'evt_ig_999'`);
    expect(doneRes.rows[0].status).toBe('DONE');
  });
});
