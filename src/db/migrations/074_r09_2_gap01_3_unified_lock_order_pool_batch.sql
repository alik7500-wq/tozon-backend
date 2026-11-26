-- Migration 074: GAP-01.3 Unified Lock Order Across Multi-Project Pool Batch
-- Global lock hierarchy across ALL assignment paths:
--   1. leads (FOR UPDATE / SKIP LOCKED)
--   2. lead_distribution_settings (ORDER BY id ASC FOR UPDATE, including id = 1 and all batch project rows)
--   3. users (ORDER BY id ASC FOR UPDATE)
-- Additive migration only. Preserves closed EXECUTE grants and fixed search_path.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_run_lead_pool_batch(
    p_batch_size INT DEFAULT 25,
    p_ignore_enabled BOOLEAN DEFAULT FALSE,
    p_now TIMESTAMPTZ DEFAULT NOW()
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_got_lock BOOLEAN;
    v_settings RECORD;
    v_lead RECORD;
    v_res JSONB;
    v_scanned INT := 0;
    v_assigned INT := 0;
    v_pooled INT := 0;
    v_skipped INT := 0;
    v_errors INT := 0;
    v_next_attempts INT;
BEGIN
    SELECT pg_try_advisory_xact_lock(746968) INTO v_got_lock;
    IF NOT v_got_lock THEN
        RETURN jsonb_build_object(
            'skipped', true,
            'reason', 'POOL_WORKER_LOCKED',
            'scanned', 0,
            'assigned', 0,
            'pooled', 0,
            'errors', 0
        );
    END IF;

    -- Lock order 1: Materialize & lock all batch leads upfront BEFORE any settings/users locks
    CREATE TEMP TABLE IF NOT EXISTS _tmp_pool_batch (
        id BIGINT,
        interested_project_id BIGINT,
        version INT,
        pool_attempts INT
    ) ON COMMIT DROP;
    TRUNCATE _tmp_pool_batch;

    INSERT INTO _tmp_pool_batch (id, interested_project_id, version, pool_attempts)
    SELECT l.id, l.interested_project_id, l.version, l.pool_attempts
    FROM public.leads l
    WHERE l.responsible_user_id IS NULL
      AND l.archived_at IS NULL
      AND l.status <> 'LOST'
      AND COALESCE(l.stage, l.status) NOT IN ('LOST', 'SIGNED')
      AND COALESCE(l.pool_next_attempt_at, p_now) <= p_now
      AND NOT EXISTS (
          SELECT 1
          FROM public.deals d
          WHERE d.lead_id = l.id
            AND d.status = 'SIGNED'
      )
    ORDER BY l.pool_next_attempt_at ASC NULLS FIRST, l.created_at ASC, l.id ASC
    LIMIT LEAST(100, GREATEST(1, COALESCE(p_batch_size, 25)))
    FOR UPDATE OF l SKIP LOCKED;

    -- Lock order 2: Lock global settings (id = 1) AND all project-scoped settings for this batch in deterministic id ASC order
    PERFORM 1
    FROM public.lead_distribution_settings s
    WHERE s.id = 1
       OR s.project_id IS NULL
       OR s.project_id IN (
           SELECT DISTINCT b.interested_project_id
           FROM _tmp_pool_batch b
           WHERE b.interested_project_id IS NOT NULL
       )
    ORDER BY s.id ASC
    FOR UPDATE;

    SELECT *
    INTO v_settings
    FROM public.lead_distribution_settings
    WHERE id = 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'skipped', true,
            'reason', 'SETTINGS_READ_ERROR',
            'scanned', 0,
            'assigned', 0,
            'pooled', 0,
            'errors', 0
        );
    END IF;

    IF NOT p_ignore_enabled AND COALESCE(v_settings.pool_worker_enabled, FALSE) IS NOT TRUE THEN
        RETURN jsonb_build_object(
            'skipped', true,
            'reason', 'POOL_WORKER_DISABLED_DB',
            'scanned', 0,
            'assigned', 0,
            'pooled', 0,
            'errors', 0
        );
    END IF;

    -- Lock order 3: Lock all active sales rep user rows in deterministic id ASC order BEFORE processing any lead
    PERFORM 1
    FROM public.users u
    WHERE u.is_active = 1
      AND u.is_sales_rep IS TRUE
    ORDER BY u.id ASC
    FOR UPDATE;

    FOR v_lead IN
        SELECT id, version, pool_attempts
        FROM _tmp_pool_batch
    LOOP
        v_scanned := v_scanned + 1;
        v_res := public.fn_select_and_assign_lead_atomic(
            v_lead.id,
            NULL,
            v_lead.version,
            'POOL_WORKER',
            p_now
        );

        IF COALESCE((v_res->>'success')::BOOLEAN, FALSE) IS NOT TRUE THEN
            v_errors := v_errors + 1;
        ELSIF v_res->>'status' = 'ASSIGNED' THEN
            v_assigned := v_assigned + 1;
        ELSIF v_res->>'status' = 'POOLED' THEN
            v_pooled := v_pooled + 1;
            v_next_attempts := COALESCE(v_lead.pool_attempts, 0) + 1;
            UPDATE public.leads
            SET pool_attempts = v_next_attempts,
                pool_next_attempt_at = p_now + (LEAST(60, POWER(2, LEAST(6, v_next_attempts - 1))) * INTERVAL '1 minute')
            WHERE id = v_lead.id;
        ELSE
            v_skipped := v_skipped + 1;
        END IF;
    END LOOP;

    -- Lock on id = 1 is already held from Lock order 2
    UPDATE public.lead_distribution_settings
    SET last_pool_run_at = p_now,
        last_pool_success_at = CASE WHEN v_errors = 0 THEN p_now ELSE last_pool_success_at END,
        last_pool_error = CASE WHEN v_errors > 0 THEN 'POOL_ASSIGNMENT_ERRORS' ELSE NULL END,
        updated_at = p_now
    WHERE id = 1;

    RETURN jsonb_build_object(
        'skipped', false,
        'scanned', v_scanned,
        'assigned', v_assigned,
        'pooled', v_pooled,
        'skipped_terminal', v_skipped,
        'errors', v_errors
    );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_run_lead_pool_batch(INT, BOOLEAN, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_run_lead_pool_batch(INT, BOOLEAN, TIMESTAMPTZ) TO service_role, postgres;

COMMIT;
