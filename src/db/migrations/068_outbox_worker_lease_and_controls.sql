-- =============================================================================
-- Migration 068: Outbox Worker Lease, Quarantine, Cutoff & Atomic Claim/Ack (R08)
-- Description:
--   1. Extends public.crm_event_outbox with lease_token, lease_expires_at,
--      locked_by, quarantine metadata, error_kind, and replay audit fields.
--   2. Adds public.crm_outbox_settings (default is_enabled = FALSE, safe cutoff_at).
--   3. Adds unique index on public.tasks(event_ref, rule_key) for idempotent tasks.
--   4. Adds atomic RPCs: fn_claim_outbox_batch & fn_complete_outbox_event.
--   5. Enqueues LEAD_ASSIGNED into crm_event_outbox inside fn_assign_lead_atomic.
-- =============================================================================

BEGIN;

ALTER TABLE public.crm_event_outbox
    ADD COLUMN IF NOT EXISTS lease_token TEXT,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS locked_by TEXT,
    ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS quarantine_reason TEXT,
    ADD COLUMN IF NOT EXISTS error_kind VARCHAR(24),
    ADD COLUMN IF NOT EXISTS replayed_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS replayed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_crm_outbox_processing_lease
    ON public.crm_event_outbox(status, lease_expires_at)
    WHERE status = 'PROCESSING';

CREATE TABLE IF NOT EXISTS public.crm_outbox_settings (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    cutoff_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    batch_size INT NOT NULL DEFAULT 25,
    lease_seconds INT NOT NULL DEFAULT 60,
    last_success_at TIMESTAMPTZ,
    last_run_at TIMESTAMPTZ,
    last_error TEXT,
    updated_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.crm_outbox_settings (id, is_enabled, cutoff_at)
VALUES (1, FALSE, NOW())
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.crm_outbox_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_crm_outbox_settings ON public.crm_outbox_settings;
CREATE POLICY service_role_all_crm_outbox_settings ON public.crm_outbox_settings
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

REVOKE ALL ON TABLE public.crm_outbox_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crm_outbox_settings TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_event_ref_rule
    ON public.tasks(event_ref, rule_key)
    WHERE event_ref IS NOT NULL AND rule_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_claim_outbox_batch(
    p_worker_id TEXT,
    p_batch_size INT DEFAULT 25,
    p_lease_seconds INT DEFAULT 60,
    p_ignore_enabled BOOLEAN DEFAULT FALSE
)
RETURNS SETOF public.crm_event_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_settings public.crm_outbox_settings%ROWTYPE;
    v_limit INT := LEAST(GREATEST(COALESCE(p_batch_size, 25), 1), 100);
    v_lease_secs INT := LEAST(GREATEST(COALESCE(p_lease_seconds, 60), 5), 600);
    v_token TEXT := md5(random()::text || clock_timestamp()::text || COALESCE(p_worker_id, 'worker'));
BEGIN
    SELECT * INTO v_settings
    FROM public.crm_outbox_settings
    WHERE id = 1;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    IF NOT p_ignore_enabled AND NOT v_settings.is_enabled THEN
        RETURN;
    END IF;

    -- Recover stuck PROCESSING rows whose lease expired
    UPDATE public.crm_event_outbox
    SET status = CASE WHEN attempts >= max_attempts THEN 'QUARANTINED' ELSE 'FAILED' END,
        quarantined_at = CASE WHEN attempts >= max_attempts THEN NOW() ELSE quarantined_at END,
        quarantine_reason = CASE WHEN attempts >= max_attempts THEN 'LEASE_EXPIRED_MAX_ATTEMPTS' ELSE quarantine_reason END,
        error_kind = CASE WHEN attempts >= max_attempts THEN 'PERMANENT' ELSE 'TRANSIENT' END,
        last_error = 'LEASE_EXPIRED',
        next_retry_at = CASE
            WHEN attempts >= max_attempts THEN next_retry_at
            ELSE NOW() + make_interval(secs => LEAST(3600, (POWER(2, LEAST(attempts, 10))::INT) * 15))
        END,
        lease_token = NULL,
        lease_expires_at = NULL,
        locked_by = NULL
    WHERE status = 'PROCESSING'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at <= NOW();

    RETURN QUERY
    WITH due AS (
        SELECT o.id
        FROM public.crm_event_outbox o
        WHERE o.status IN ('PENDING', 'FAILED')
          AND o.next_retry_at <= NOW()
          AND o.created_at >= v_settings.cutoff_at
        ORDER BY o.created_at ASC, o.id ASC
        LIMIT v_limit
        FOR UPDATE SKIP LOCKED
    )
    UPDATE public.crm_event_outbox o
    SET status = 'PROCESSING',
        attempts = o.attempts + 1,
        lease_token = v_token || '_' || o.id::TEXT,
        lease_expires_at = NOW() + make_interval(secs => v_lease_secs),
        locked_by = COALESCE(NULLIF(trim(p_worker_id), ''), 'outbox-worker')
    FROM due
    WHERE o.id = due.id
    RETURNING o.*;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_claim_outbox_batch(TEXT, INT, INT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_outbox_batch(TEXT, INT, INT, BOOLEAN) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_complete_outbox_event(
    p_event_id BIGINT,
    p_lease_token TEXT,
    p_outcome TEXT,
    p_error_kind TEXT DEFAULT NULL,
    p_error_message TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.crm_event_outbox%ROWTYPE;
    v_outcome TEXT := UPPER(COALESCE(p_outcome, ''));
BEGIN
    SELECT * INTO v_row
    FROM public.crm_event_outbox
    WHERE id = p_event_id
      AND status = 'PROCESSING'
      AND lease_token = p_lease_token
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'code', 'LEASE_LOST');
    END IF;

    IF v_outcome = 'DONE' THEN
        UPDATE public.crm_event_outbox
        SET status = 'DONE',
            processed_at = NOW(),
            last_error = NULL,
            error_kind = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            locked_by = NULL
        WHERE id = v_row.id
        RETURNING * INTO v_row;

        RETURN jsonb_build_object('ok', true, 'status', v_row.status);
    END IF;

    IF v_outcome = 'QUARANTINE' OR v_row.attempts >= v_row.max_attempts THEN
        UPDATE public.crm_event_outbox
        SET status = 'QUARANTINED',
            quarantined_at = NOW(),
            quarantine_reason = COALESCE(NULLIF(trim(p_error_message), ''), 'MAX_ATTEMPTS_OR_PERMANENT'),
            error_kind = COALESCE(NULLIF(trim(p_error_kind), ''), 'PERMANENT'),
            last_error = p_error_message,
            lease_token = NULL,
            lease_expires_at = NULL,
            locked_by = NULL
        WHERE id = v_row.id
        RETURNING * INTO v_row;

        RETURN jsonb_build_object('ok', true, 'status', v_row.status);
    END IF;

    -- TRANSIENT RETRY with exponential backoff
    UPDATE public.crm_event_outbox
    SET status = 'FAILED',
        error_kind = COALESCE(NULLIF(trim(p_error_kind), ''), 'TRANSIENT'),
        last_error = p_error_message,
        next_retry_at = NOW() + make_interval(secs => LEAST(3600, (POWER(2, LEAST(v_row.attempts, 10))::INT) * 15)),
        lease_token = NULL,
        lease_expires_at = NULL,
        locked_by = NULL
    WHERE id = v_row.id
    RETURNING * INTO v_row;

    RETURN jsonb_build_object('ok', true, 'status', v_row.status, 'next_retry_at', v_row.next_retry_at);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_complete_outbox_event(BIGINT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_complete_outbox_event(BIGINT, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- Atomic outbox triggers so business change + durable event share one transaction
CREATE OR REPLACE FUNCTION public.fn_trg_leads_enqueue_outbox()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO public.crm_event_outbox (
        event_type, aggregate_type, aggregate_id, idempotency_key, payload_json
    ) VALUES (
        CASE WHEN COALESCE(NEW.is_historical_import, FALSE) THEN 'LEAD_IMPORTED' ELSE 'LEAD_CREATED' END,
        'lead',
        NEW.id::TEXT,
        format('lead_created_%s', NEW.id),
        jsonb_build_object(
            'lead_id', NEW.id,
            'project_id', NEW.interested_project_id,
            'responsible_user_id', NEW.responsible_user_id,
            'source_code', COALESCE(NEW.source_code, NEW.source),
            'is_historical_import', COALESCE(NEW.is_historical_import, FALSE)
        )
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_leads_enqueue_outbox ON public.leads;
CREATE TRIGGER trg_leads_enqueue_outbox
    AFTER INSERT ON public.leads
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_trg_leads_enqueue_outbox();

CREATE OR REPLACE FUNCTION public.fn_trg_lead_assignment_enqueue_outbox()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.to_user_id IS NOT NULL THEN
        INSERT INTO public.crm_event_outbox (
            event_type, aggregate_type, aggregate_id, idempotency_key, payload_json
        ) VALUES (
            'LEAD_ASSIGNED',
            'lead',
            NEW.lead_id::TEXT,
            format('assign_%s_h%s', NEW.lead_id, NEW.id),
            jsonb_build_object(
                'lead_id', NEW.lead_id,
                'from_user_id', NEW.from_user_id,
                'to_user_id', NEW.to_user_id,
                'actor_user_id', NEW.assigned_by_user_id,
                'assignment_type', NEW.assignment_type
            )
        )
        ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lead_assignment_enqueue_outbox ON public.lead_assignment_history;
CREATE TRIGGER trg_lead_assignment_enqueue_outbox
    AFTER INSERT ON public.lead_assignment_history
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_trg_lead_assignment_enqueue_outbox();

CREATE OR REPLACE FUNCTION public.fn_trg_lead_comm_enqueue_outbox()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO public.crm_event_outbox (
        event_type, aggregate_type, aggregate_id, idempotency_key, payload_json
    ) VALUES (
        'COMMUNICATION_LOGGED',
        'lead',
        NEW.lead_id::TEXT,
        format('comm_%s_%s', NEW.lead_id, NEW.id),
        jsonb_build_object(
            'lead_id', NEW.lead_id,
            'communication_id', NEW.id,
            'actor_user_id', NEW.actor_user_id,
            'channel', NEW.channel,
            'direction', NEW.direction,
            'comm_event_type', NEW.event_type,
            'outcome', NEW.outcome,
            'project_id', NEW.project_id
        )
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lead_comm_enqueue_outbox ON public.lead_communications;
CREATE TRIGGER trg_lead_comm_enqueue_outbox
    AFTER INSERT ON public.lead_communications
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_trg_lead_comm_enqueue_outbox();

COMMIT;
