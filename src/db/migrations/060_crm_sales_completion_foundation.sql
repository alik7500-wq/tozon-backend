-- =============================================================================
-- Migration 060: CRM Sales Completion V1.0 Foundation (P0/P1/P2 Schema)
-- Description:
--   Idempotent, additive-only migration implementing:
--   1. Persistent contacts & phone-optional leads (A06-A08)
--   2. Canonical funnel stages, CAS version, distinct SLA timestamps (F-01, F-02, F-12, F-14)
--   3. Exact task due_at (UTC) + date-only flag + idempotent rule_key (F-13)
--   4. Unified communication/meeting/showing log & stage history (F-02, F-10, F-12)
--   5. Project-scoped distribution settings & DB round-robin cursor + CAS fn_assign_lead_atomic (F-08, F-09)
--   6. Durable event outbox, automation rules/executions & call AI analyses (N-03, F-19, F-20)
-- =============================================================================

BEGIN;

-- 1. Contacts (durable identity separate from lead interest)
CREATE TABLE IF NOT EXISTS public.contacts (
    id BIGSERIAL PRIMARY KEY,
    organization_id BIGINT NOT NULL DEFAULT 1,
    full_name TEXT NOT NULL DEFAULT 'Контакт',
    phone TEXT,
    normalized_phone TEXT,
    secondary_phone TEXT,
    instagram_account_id TEXT,
    external_contact_id TEXT,
    source_code VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contacts_normalized_phone
    ON public.contacts(organization_id, normalized_phone)
    WHERE normalized_phone IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_instagram_identity
    ON public.contacts(organization_id, instagram_account_id, external_contact_id)
    WHERE instagram_account_id IS NOT NULL AND external_contact_id IS NOT NULL;

-- 2. Extend public.leads (preserve existing status & columns; allow NULL phone)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'phone' AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE public.leads ALTER COLUMN phone DROP NOT NULL;
    END IF;
END $$;

ALTER TABLE public.leads
    ADD COLUMN IF NOT EXISTS organization_id BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS contact_id BIGINT REFERENCES public.contacts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS stage VARCHAR(50),
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS first_human_action_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS first_contact_confirmed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS first_contact_origin VARCHAR(50),
    ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS unread_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS pause_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS pause_reason TEXT,
    ADD COLUMN IF NOT EXISTS pause_set_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS pool_reason VARCHAR(100),
    ADD COLUMN IF NOT EXISTS lost_reason_code VARCHAR(50),
    ADD COLUMN IF NOT EXISTS lost_reason_comment TEXT,
    ADD COLUMN IF NOT EXISTS source_code VARCHAR(64),
    ADD COLUMN IF NOT EXISTS utm_data JSONB,
    ADD COLUMN IF NOT EXISTS is_historical_import BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_leads_stage ON public.leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_contact_id ON public.leads(contact_id);
CREATE INDEX IF NOT EXISTS idx_leads_project_stage ON public.leads(interested_project_id, stage);
CREATE INDEX IF NOT EXISTS idx_leads_last_inbound_at ON public.leads(last_inbound_at DESC);

-- Backfill stage safely without converting unverified WON into SIGNED
UPDATE public.leads
SET stage = CASE
    WHEN status = 'NEW' THEN 'NEW'
    WHEN status = 'IN_PROGRESS' THEN 'IN_PROGRESS'
    WHEN status = 'NEGOTIATION' THEN 'NEGOTIATION'
    WHEN status = 'LOST' THEN 'LOST'
    WHEN status = 'WON' THEN 'CONTRACT_PREP'
    ELSE 'NEW'
END
WHERE stage IS NULL;

-- 3. Extend public.tasks with exact due_at (UTC), date-only marker, and outcome
ALTER TABLE public.tasks
    ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS due_date_only BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Dushanbe',
    ADD COLUMN IF NOT EXISTS outcome VARCHAR(50),
    ADD COLUMN IF NOT EXISTS outcome_notes TEXT,
    ADD COLUMN IF NOT EXISTS completed_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS cancel_reason TEXT,
    ADD COLUMN IF NOT EXISTS rule_key VARCHAR(100),
    ADD COLUMN IF NOT EXISTS event_ref VARCHAR(255);

-- Allow multiple legitimate future CALL tasks with distinct idempotency_key (F-13.7)
DROP INDEX IF EXISTS public.uq_tasks_open_lead_call;

CREATE INDEX IF NOT EXISTS idx_tasks_due_at_open
    ON public.tasks(due_at)
    WHERE status = 'OPEN' AND due_at IS NOT NULL;

-- 4. Communication, Call, Meeting & Showing Log (F-02, F-10, F-12)
CREATE TABLE IF NOT EXISTS public.lead_communications (
    id BIGSERIAL PRIMARY KEY,
    lead_id BIGINT NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
    contact_id BIGINT REFERENCES public.contacts(id) ON DELETE SET NULL,
    actor_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    channel VARCHAR(32) NOT NULL, -- CALL, INSTAGRAM, SMS, MEETING, SHOWING, NOTE
    direction VARCHAR(16) NOT NULL DEFAULT 'INTERNAL', -- INBOUND, OUTBOUND, INTERNAL
    event_type VARCHAR(48) NOT NULL, -- ATTEMPT, NO_ANSWER, BUSY, CONNECTED_CALL, OUTBOUND_MESSAGE, INBOUND_MESSAGE, MEETING_SCHEDULED, MEETING_DONE, MEETING_RESCHEDULED, MEETING_NO_SHOW, SHOWING_SCHEDULED, SHOWING_DONE, SHOWING_RESCHEDULED, SHOWING_NO_SHOW, AUTO_NOTIFICATION
    is_manual BOOLEAN NOT NULL DEFAULT FALSE,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    project_id BIGINT,
    unit_id BIGINT,
    outcome VARCHAR(64),
    notes TEXT,
    external_event_id VARCHAR(255),
    idempotency_key VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_comms_lead_occurred
    ON public.lead_communications(lead_id, occurred_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_comms_idempotency
    ON public.lead_communications(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- 5. Lead Stage History (F-02)
CREATE TABLE IF NOT EXISTS public.lead_stage_history (
    id BIGSERIAL PRIMARY KEY,
    lead_id BIGINT NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
    from_stage VARCHAR(50),
    to_stage VARCHAR(50) NOT NULL,
    actor_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    reason TEXT,
    evidence_ref TEXT,
    lead_version INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_stage_history_lead
    ON public.lead_stage_history(lead_id, created_at DESC);

-- 6. Project-scoped Distribution Settings & DB Round-Robin Cursor (F-08, F-09)
ALTER TABLE public.lead_distribution_settings
    ADD COLUMN IF NOT EXISTS project_id BIGINT,
    ADD COLUMN IF NOT EXISTS work_start_hour INTEGER NOT NULL DEFAULT 9,
    ADD COLUMN IF NOT EXISTS work_end_hour INTEGER NOT NULL DEFAULT 18,
    ADD COLUMN IF NOT EXISTS work_days_json JSONB NOT NULL DEFAULT '[1,2,3,4,5,6]'::jsonb,
    ADD COLUMN IF NOT EXISTS sla_first_response_minutes INTEGER NOT NULL DEFAULT 15,
    ADD COLUMN IF NOT EXISTS allowed_user_ids JSONB,
    ADD COLUMN IF NOT EXISTS round_robin_cursor BIGINT NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_dist_settings_project
    ON public.lead_distribution_settings(project_id)
    WHERE project_id IS NOT NULL;

-- Hardened atomic assignment with CAS version check and fixed search_path
CREATE OR REPLACE FUNCTION public.fn_assign_lead_atomic(
    p_lead_id BIGINT,
    p_target_user_id BIGINT,
    p_actor_user_id BIGINT,
    p_reason TEXT,
    p_max_capacity INT DEFAULT 25,
    p_is_manual BOOLEAN DEFAULT FALSE,
    p_expected_version INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_lead RECORD;
    v_target_user RECORD;
    v_from_user_id BIGINT;
    v_current_workload INT := 0;
    v_assigned_at TIMESTAMPTZ;
    v_assignment_type VARCHAR(50);
    v_new_version INT;
BEGIN
    SELECT id, status, stage, version, responsible_user_id, archived_at
    INTO v_lead
    FROM public.leads
    WHERE id = p_lead_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'LEAD_NOT_FOUND',
            'message', 'Лид не найден'
        );
    END IF;

    IF v_lead.archived_at IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'LEAD_ARCHIVED',
            'message', 'Лид архивирован'
        );
    END IF;

    IF p_expected_version IS NOT NULL AND v_lead.version IS DISTINCT FROM p_expected_version THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'VERSION_CONFLICT',
            'message', 'Карточка лида была изменена другим пользователем или процессом',
            'current_version', v_lead.version,
            'current_responsible_user_id', v_lead.responsible_user_id
        );
    END IF;

    v_from_user_id := v_lead.responsible_user_id;

    IF NOT p_is_manual AND v_from_user_id IS NOT NULL AND v_from_user_id > 0 THEN
        RETURN jsonb_build_object(
            'success', true,
            'status', 'PRESERVED_EXISTING',
            'lead_id', p_lead_id,
            'responsible_user_id', v_from_user_id,
            'version', v_lead.version,
            'message', 'Лид уже закреплен за менеджером'
        );
    END IF;

    IF p_target_user_id IS NOT NULL THEN
        SELECT id, name, role, is_active, is_sales_rep
        INTO v_target_user
        FROM public.users
        WHERE id = p_target_user_id
        FOR UPDATE;

        IF NOT FOUND OR v_target_user.is_active IS DISTINCT FROM 1 OR v_target_user.is_sales_rep IS NOT TRUE THEN
            RETURN jsonb_build_object(
                'success', false,
                'error_code', 'INVALID_TARGET_USER',
                'message', 'Менеджер не активен или не имеет права на приём лидов'
            );
        END IF;

        IF NOT p_is_manual THEN
            SELECT COUNT(*)::INT
            INTO v_current_workload
            FROM public.leads
            WHERE responsible_user_id = p_target_user_id
              AND status IN ('NEW', 'IN_PROGRESS', 'NEGOTIATION')
              AND archived_at IS NULL;

            IF v_current_workload >= COALESCE(p_max_capacity, 25) THEN
                RETURN jsonb_build_object(
                    'success', false,
                    'error_code', 'CAPACITY_EXCEEDED',
                    'message', 'Достигнут лимит активных лидов для менеджера'
                );
            END IF;
        END IF;
    END IF;

    v_assigned_at := NOW();
    v_assignment_type := CASE WHEN p_is_manual THEN 'MANUAL' ELSE 'ROUND_ROBIN' END;
    v_new_version := COALESCE(v_lead.version, 1) + 1;

    UPDATE public.leads
    SET responsible_user_id = p_target_user_id,
        assigned_at = CASE WHEN p_target_user_id IS NOT NULL THEN v_assigned_at ELSE NULL END,
        reassignment_reason = p_reason,
        pool_reason = CASE WHEN p_target_user_id IS NULL THEN COALESCE(p_reason, 'MANUAL_UNASSIGN') ELSE NULL END,
        version = v_new_version,
        updated_at = v_assigned_at::TEXT
    WHERE id = p_lead_id;

    INSERT INTO public.lead_assignment_history (
        lead_id, from_user_id, to_user_id, assigned_by_user_id, assignment_type, reason, created_at
    ) VALUES (
        p_lead_id, v_from_user_id, p_target_user_id, p_actor_user_id, v_assignment_type, p_reason, v_assigned_at
    );

    RETURN jsonb_build_object(
        'success', true,
        'status', 'ASSIGNED',
        'lead_id', p_lead_id,
        'from_user_id', v_from_user_id,
        'to_user_id', p_target_user_id,
        'version', v_new_version,
        'assigned_at', v_assigned_at
    );
END;
$$;

-- 7. Durable Event Outbox (N-03)
CREATE TABLE IF NOT EXISTS public.crm_event_outbox (
    id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(64) NOT NULL,
    aggregate_type VARCHAR(64) NOT NULL,
    aggregate_id TEXT NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL UNIQUE,
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(24) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'QUARANTINED')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_crm_outbox_due
    ON public.crm_event_outbox(status, next_retry_at)
    WHERE status IN ('PENDING', 'FAILED');

-- 8. Automation Rules & Idempotent Executions (F-19)
CREATE TABLE IF NOT EXISTS public.crm_automation_rules (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    project_id BIGINT,
    source_code VARCHAR(64),
    event_type VARCHAR(64) NOT NULL,
    conditions_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    action_type VARCHAR(64) NOT NULL,
    action_params_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    version INTEGER NOT NULL DEFAULT 1,
    created_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    updated_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.crm_automation_executions (
    id BIGSERIAL PRIMARY KEY,
    rule_id BIGINT NOT NULL REFERENCES public.crm_automation_rules(id) ON DELETE CASCADE,
    event_key VARCHAR(255) NOT NULL,
    lead_id BIGINT REFERENCES public.leads(id) ON DELETE CASCADE,
    status VARCHAR(24) NOT NULL DEFAULT 'EXECUTED' CHECK (status IN ('EXECUTED', 'SKIPPED', 'FAILED')),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (rule_id, event_key)
);

-- 9. Call AI Analysis (F-20)
CREATE TABLE IF NOT EXISTS public.call_ai_analyses (
    id BIGSERIAL PRIMARY KEY,
    communication_id BIGINT REFERENCES public.lead_communications(id) ON DELETE CASCADE,
    lead_id BIGINT NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
    status VARCHAR(32) NOT NULL DEFAULT 'NOT_CONFIGURED' CHECK (status IN ('QUEUED', 'PROCESSING', 'READY', 'FAILED', 'NO_RECORDING', 'NOT_CONFIGURED')),
    checklist_version VARCHAR(32) NOT NULL DEFAULT 'v1.0',
    model_name VARCHAR(64),
    summary TEXT,
    agreements_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    objections_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    suggested_next_step_json JSONB,
    checklist_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    fragments_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    flagged_incorrect BOOLEAN NOT NULL DEFAULT FALSE,
    flagged_reason TEXT,
    flagged_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    confirmed_task_id BIGINT REFERENCES public.tasks(id) ON DELETE SET NULL,
    idempotency_key VARCHAR(255) UNIQUE,
    last_error TEXT,
    analyzed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10. RLS & strict permissions for all new tables
DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'contacts', 'lead_communications', 'lead_stage_history',
        'crm_event_outbox', 'crm_automation_rules', 'crm_automation_executions', 'call_ai_analyses'
    ]
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', tbl);
        EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated;', tbl);
        EXECUTE format('GRANT ALL ON public.%I TO service_role, postgres;', tbl);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I;', tbl || '_service_role', tbl);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true);', tbl || '_service_role', tbl);
    END LOOP;
END $$;

COMMIT;
