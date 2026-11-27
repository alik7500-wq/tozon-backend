import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

describe('GAP-07: Compatible Data-Preserving App Rollback & Re-Upgrade (060-074)', () => {
  let db;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

      CREATE TABLE public.users (
        id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT 'u@tozon.crm',
        role TEXT NOT NULL DEFAULT 'SALES_MANAGER', permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
        is_active INT NOT NULL DEFAULT 1, is_sales_rep BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      CREATE TABLE public.payments (
        id BIGSERIAL PRIMARY KEY, deal_id BIGINT NOT NULL REFERENCES public.deals(id),
        amount_minor BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'POSTED'
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
      CREATE TABLE public.instagram_accounts (
        id BIGSERIAL PRIMARY KEY, username TEXT NOT NULL
      );
      CREATE TABLE public.instagram_threads (
        id BIGSERIAL PRIMARY KEY, instagram_account_id BIGINT, lead_id BIGINT, contact_id BIGINT
      );
      CREATE TABLE public.instagram_messages (
        id BIGSERIAL PRIMARY KEY, thread_id BIGINT, external_message_id TEXT, text TEXT
      );
    `);

    const migrations = [
      'src/db/migrations/038_create_user_notifications.sql',
      'src/db/migrations/060_crm_sales_completion_foundation.sql',
      'src/db/migrations/061_harden_fn_assign_lead_atomic_and_app_rollback.sql',
      'src/db/migrations/062_atomic_lead_stage_transition.sql',
      'src/db/migrations/063_harden_stage_transition_and_task_cancel.sql',
      'src/db/migrations/064_unified_lead_query_and_cursor.sql',
      'src/db/migrations/065_harden_unified_query_cursor_and_scope.sql',
      'src/db/migrations/066_user_project_access.sql',
      'src/db/migrations/067_instagram_send_idempotency.sql',
      'src/db/migrations/068_outbox_worker_lease_and_controls.sql',
      'src/db/migrations/069_outbox_atomic_effect_guard.sql',
      'src/db/migrations/070_r09_1_outbox_and_project_access_tx.sql',
      'src/db/migrations/071_r09_2_gap01_transactional_distribution.sql',
      'src/db/migrations/072_r09_2_gap01_1_cross_project_capacity_and_pool_backoff.sql',
      'src/db/migrations/073_r09_2_gap01_2_pool_lock_order_and_manual_project_access.sql',
      'src/db/migrations/074_r09_2_gap01_3_unified_lock_order_pool_batch.sql'
    ];
    for (const file of migrations) {
      await db.exec(readFileSync(file, 'utf8'));
    }
  }, 45000);

  it('executes full cycle: seed post-release data -> idempotent app_rollback_060_074 -> verify preservation/RBAC -> re-upgrade without duplicates', async () => {
    await db.exec(`
      INSERT INTO public.projects (id, name) VALUES (1, 'Somon Residence');
      INSERT INTO public.users (id, name, email, role, is_active, is_sales_rep, all_projects_access) VALUES
        (1, 'Admin', 'a@t.tj', 'ADMIN', 1, FALSE, TRUE),
        (2, 'Manager', 'm@t.tj', 'SALES_MANAGER', 1, TRUE, FALSE);
      INSERT INTO public.user_project_access (user_id, project_id, can_view) VALUES (2, 1, TRUE);
      INSERT INTO public.contacts (id, full_name, normalized_phone) VALUES (1, 'Buyer 1', '+992900000001');

      -- 1: SIGNED deal lead; 2: Legacy WON without SIGNED deal; 3: RESERVED deal lead; 4: LOST lead
      INSERT INTO public.leads (id, full_name, phone, status, stage, responsible_user_id, interested_project_id, contact_id) VALUES
        (10, 'Signed Lead', '+992900000001', 'CONTRACT_PREP', 'SIGNED', 2, 1, 1),
        (11, 'Legacy WON No Deal', '+992900000002', 'WON', 'CONTRACT_PREP', 2, 1, NULL),
        (12, 'Reserved Lead', '+992900000003', 'NEW', 'RESERVED', 2, 1, NULL),
        (13, 'Lost Lead', '+992900000004', 'LOST', 'LOST', 2, 1, NULL);

      INSERT INTO public.deals (id, lead_id, unit_id, responsible_user_id, status) VALUES
        (100, 10, 1, 2, 'SIGNED'),
        (101, 12, 2, 2, 'RESERVED');
      INSERT INTO public.payments (id, deal_id, amount_minor, status) VALUES (1000, 100, 500000, 'POSTED');

      INSERT INTO public.tasks (id, lead_id, assigned_user_id, title, due_date, due_at, due_date_only, status) VALUES
        (200, 10, 2, 'Exact Task', '2026-12-01', '2026-12-01T09:00:00Z', FALSE, 'OPEN');

      INSERT INTO public.lead_stage_history (lead_id, from_stage, to_stage, actor_user_id) VALUES (10, 'NEW', 'SIGNED', 2);
      INSERT INTO public.lead_assignment_history (lead_id, to_user_id, assigned_by_user_id, assignment_type) VALUES (10, 2, 1, 'MANUAL');

      INSERT INTO public.crm_outbox_settings (id, is_enabled) VALUES (1, TRUE)
      ON CONFLICT (id) DO UPDATE SET is_enabled = TRUE;
      INSERT INTO public.lead_distribution_settings (id, enabled, pool_worker_enabled) VALUES (1, TRUE, TRUE)
      ON CONFLICT (id) DO UPDATE SET enabled = TRUE, pool_worker_enabled = TRUE;

      INSERT INTO public.crm_automation_rules (id, name, event_type, action_type, is_enabled)
      VALUES (1, 'Rule 1', 'LEAD_CREATED', 'CREATE_TASK', TRUE);

      INSERT INTO public.crm_event_outbox (event_type, aggregate_type, aggregate_id, idempotency_key, status, lease_token, locked_by)
      VALUES
        ('LEAD_CREATED', 'lead', '10', 'k_proc_10', 'PROCESSING', 'lease_abc', 'worker_1'),
        ('LEAD_CREATED', 'lead', '12', 'k_quar_12', 'QUARANTINED', NULL, NULL);

      INSERT INTO public.crm_instagram_send_operations (
        actor_user_id, account_id, contact_id, idempotency_key, request_hash, normalized_text, status, external_message_id, lease_expires_at
      ) VALUES (1, '1', 'ig_u_1', 'ig_key_1', 'hash_1', 'Hello', 'UNKNOWN', 'ext_msg_999', NOW() + INTERVAL '1 hour');

      INSERT INTO public.call_ai_analyses (id, lead_id, status, summary) VALUES (1, 10, 'READY', 'Summary');
    `);

    const rollbackSql = readFileSync('src/db/migrations/app_rollback_060_074_preserve_data.sql', 'utf8');

    // Run rollback twice to verify idempotency
    await db.exec(rollbackSql);
    await db.exec(rollbackSql);

    // 1. Workers & automation rules disabled
    expect((await db.query(`SELECT is_enabled FROM public.crm_outbox_settings WHERE id = 1`)).rows[0].is_enabled).toBe(false);
    expect((await db.query(`SELECT pool_worker_enabled FROM public.lead_distribution_settings WHERE id = 1`)).rows[0].pool_worker_enabled).toBe(false);
    expect((await db.query(`SELECT is_enabled FROM public.crm_automation_rules WHERE id = 1`)).rows[0].is_enabled).toBe(false);

    // 2. Active PROCESSING lease safely released to FAILED; QUARANTINED & idempotency keys preserved
    const procEvt = (await db.query(`SELECT status, lease_token, last_error FROM public.crm_event_outbox WHERE idempotency_key = 'k_proc_10'`)).rows[0];
    expect(procEvt).toMatchObject({ status: 'FAILED', lease_token: null, last_error: 'APP_ROLLBACK_LEASE_RELEASED' });
    expect((await db.query(`SELECT status FROM public.crm_event_outbox WHERE idempotency_key = 'k_quar_12'`)).rows[0].status).toBe('QUARANTINED');

    // 3. Authoritative SIGNED vs legacy WON status alignment
    const statuses = (await db.query(`SELECT id, status FROM public.leads ORDER BY id`)).rows;
    expect(statuses).toEqual([
      { id: 10, status: 'WON' },          // Has SIGNED deal -> WON
      { id: 11, status: 'NEGOTIATION' },  // Legacy WON without SIGNED deal -> NEGOTIATION (not sale!)
      { id: 12, status: 'NEGOTIATION' },  // RESERVED deal -> NEGOTIATION
      { id: 13, status: 'LOST' }          // LOST -> LOST
    ]);

    // 4. All business data & fields preserved
    expect((await db.query(`SELECT COUNT(*)::int AS c FROM public.contacts`)).rows[0].c).toBe(1);
    expect((await db.query(`SELECT COUNT(*)::int AS c FROM public.deals`)).rows[0].c).toBe(2);
    expect((await db.query(`SELECT COUNT(*)::int AS c FROM public.payments`)).rows[0].c).toBe(1);
    expect((await db.query(`SELECT COUNT(*)::int AS c FROM public.user_project_access`)).rows[0].c).toBe(1);
    expect((await db.query(`SELECT COUNT(*)::int AS c FROM public.call_ai_analyses`)).rows[0].c).toBe(1);
    const taskRow = (await db.query(`SELECT due_at, due_date_only FROM public.tasks WHERE id = 200`)).rows[0];
    expect(taskRow.due_date_only).toBe(false);
    expect(new Date(taskRow.due_at).toISOString()).toBe('2026-12-01T09:00:00.000Z');
    const igOp = (await db.query(`SELECT status, external_message_id FROM public.crm_instagram_send_operations WHERE idempotency_key = 'ig_key_1'`)).rows[0];
    expect(igOp).toEqual({ status: 'UNKNOWN', external_message_id: 'ext_msg_999' });

    // 5. Privileges remain locked for anon/authenticated
    const anonCanExec = (await db.query(
      `SELECT has_function_privilege('anon', 'public.fn_assign_lead_atomic(bigint,bigint,bigint,text,int,boolean,int)', 'EXECUTE') AS priv`
    )).rows[0].priv;
    expect(anonCanExec).toBe(false);
    const anonCanReadOutbox = (await db.query(
      `SELECT has_table_privilege('anon', 'public.crm_event_outbox', 'SELECT') AS priv`
    )).rows[0].priv;
    expect(anonCanReadOutbox).toBe(false);

    // 6. Re-upgrade: re-apply additive 074 idempotently -> zero data loss or duplicate effects
    await db.exec(readFileSync('src/db/migrations/074_r09_2_gap01_3_unified_lock_order_pool_batch.sql', 'utf8'));
    expect((await db.query(`SELECT COUNT(*)::int AS c FROM public.leads`)).rows[0].c).toBe(4);
    expect((await db.query(`SELECT COUNT(*)::int AS c FROM public.deals`)).rows[0].c).toBe(2);
  });
});
