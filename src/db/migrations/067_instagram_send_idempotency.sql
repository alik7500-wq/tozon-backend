-- =============================================================================
-- Migration 067: Durable Instagram Send Idempotency & Reconciliation (R06)
-- Description:
--   Stores persistent per-operation state in PostgreSQL so two backend processes
--   cannot send the same idempotency_key concurrently, expired leases become
--   UNKNOWN (never auto-retried), and confirmed sends replay without re-sending.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.crm_instagram_send_operations (
    id BIGSERIAL PRIMARY KEY,
    actor_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    normalized_text TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('IN_PROGRESS', 'CONFIRMED', 'FAILED', 'UNKNOWN')),
    external_message_id TEXT,
    saved_to_history BOOLEAN NOT NULL DEFAULT FALSE,
    error_code TEXT,
    error_status INT,
    response_payload JSONB,
    lease_expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_crm_ig_send_actor_key UNIQUE (actor_user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_crm_ig_send_lookup
    ON public.crm_instagram_send_operations(actor_user_id, account_id, contact_id, created_at DESC);

ALTER TABLE public.crm_instagram_send_operations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_crm_ig_send ON public.crm_instagram_send_operations;
CREATE POLICY service_role_all_crm_ig_send ON public.crm_instagram_send_operations
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

REVOKE ALL ON TABLE public.crm_instagram_send_operations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crm_instagram_send_operations TO service_role;

CREATE OR REPLACE FUNCTION public.fn_instagram_send_claim(
    p_actor_user_id BIGINT,
    p_account_id TEXT,
    p_contact_id TEXT,
    p_idempotency_key TEXT,
    p_request_hash TEXT,
    p_normalized_text TEXT,
    p_lease_seconds INT DEFAULT 60
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_op public.crm_instagram_send_operations%ROWTYPE;
BEGIN
    INSERT INTO public.crm_instagram_send_operations (
        actor_user_id,
        account_id,
        contact_id,
        idempotency_key,
        request_hash,
        normalized_text,
        status,
        lease_expires_at,
        created_at,
        updated_at
    )
    VALUES (
        p_actor_user_id,
        p_account_id,
        p_contact_id,
        p_idempotency_key,
        p_request_hash,
        p_normalized_text,
        'IN_PROGRESS',
        NOW() + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 60), 5)),
        NOW(),
        NOW()
    )
    ON CONFLICT (actor_user_id, idempotency_key) DO NOTHING
    RETURNING * INTO v_op;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'action', 'PROCEED',
            'operation', to_jsonb(v_op)
        );
    END IF;

    SELECT * INTO v_op
    FROM public.crm_instagram_send_operations
    WHERE actor_user_id = p_actor_user_id
      AND idempotency_key = p_idempotency_key
    FOR UPDATE;

    IF v_op.request_hash <> p_request_hash THEN
        RETURN jsonb_build_object(
            'action', 'CONFLICT',
            'operation', to_jsonb(v_op)
        );
    END IF;

    IF v_op.status = 'CONFIRMED' THEN
        RETURN jsonb_build_object(
            'action', 'REPLAY_CONFIRMED',
            'operation', to_jsonb(v_op)
        );
    END IF;

    IF v_op.status = 'FAILED' THEN
        RETURN jsonb_build_object(
            'action', 'REPLAY_FAILED',
            'operation', to_jsonb(v_op)
        );
    END IF;

    IF v_op.status = 'UNKNOWN' THEN
        RETURN jsonb_build_object(
            'action', 'UNKNOWN',
            'operation', to_jsonb(v_op)
        );
    END IF;

    -- status = IN_PROGRESS
    IF v_op.lease_expires_at > NOW() THEN
        RETURN jsonb_build_object(
            'action', 'IN_PROGRESS',
            'operation', to_jsonb(v_op)
        );
    END IF;

    -- Expired lease NEVER proves message was not sent: transition to UNKNOWN
    UPDATE public.crm_instagram_send_operations
    SET status = 'UNKNOWN',
        error_code = COALESCE(error_code, 'INSTAGRAM_SEND_UNCONFIRMED'),
        error_status = COALESCE(error_status, 503),
        updated_at = NOW()
    WHERE id = v_op.id
    RETURNING * INTO v_op;

    RETURN jsonb_build_object(
        'action', 'UNKNOWN',
        'operation', to_jsonb(v_op)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_instagram_send_claim(BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_instagram_send_claim(BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, INT) TO service_role;

COMMIT;
