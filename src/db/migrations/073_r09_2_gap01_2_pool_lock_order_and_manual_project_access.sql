-- Migration 073: GAP-01.2 Eliminate Pool Batch Lock Inversion & Enforce Project Access in fn_assign_lead_atomic
-- Additive migration only. Preserves closed EXECUTE grants and fixed search_path.

BEGIN;

-- 1. Enforce project access inside fn_assign_lead_atomic (including manual mode)
--    Unified lock order: leads (FOR UPDATE) -> users (FOR UPDATE)
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
    v_has_project_access BOOLEAN := FALSE;
BEGIN
    SELECT id, status, stage, version, responsible_user_id, interested_project_id, archived_at
    INTO v_lead
    FROM public.leads
    WHERE id = p_lead_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'LEAD_NOT_FOUND', 'message', 'Лид не найден');
    END IF;

    IF v_lead.archived_at IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'LEAD_ARCHIVED', 'message', 'Лид архивирован');
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
        SELECT id, name, role, is_active, is_sales_rep, COALESCE(all_projects_access, FALSE) AS all_projects_access
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

        -- Enforce project isolation for BOTH manual and automated assignments
        IF v_lead.interested_project_id IS NOT NULL THEN
            SELECT (
                v_target_user.all_projects_access IS TRUE
                OR EXISTS (
                    SELECT 1
                    FROM public.user_project_access upa
                    WHERE upa.user_id = p_target_user_id
                      AND upa.project_id = v_lead.interested_project_id
                      AND upa.can_view IS TRUE
                )
            ) INTO v_has_project_access;
        ELSE
            v_has_project_access := (v_target_user.all_projects_access IS TRUE);
        END IF;

        IF NOT v_has_project_access THEN
            RETURN jsonb_build_object(
                'success', false,
                'error_code', 'PROJECT_ACCESS_DENIED',
                'message', 'Менеджер не имеет допуска к проекту этого лида'
            );
        END IF;

        IF NOT p_is_manual THEN
            SELECT COUNT(*)::INT
            INTO v_current_workload
            FROM public.leads l
            WHERE l.responsible_user_id = p_target_user_id
              AND l.archived_at IS NULL
              AND l.status <> 'LOST'
              AND COALESCE(l.stage, l.status) NOT IN ('LOST', 'SIGNED')
              AND NOT EXISTS (
                  SELECT 1 FROM public.deals d WHERE d.lead_id = l.id AND d.status = 'SIGNED'
              );

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

-- 2. Eliminate lock inversion in fn_run_lead_pool_batch:
--    Materialize and lock ALL batch leads upfront via FOR UPDATE OF l SKIP LOCKED
--    BEFORE acquiring any lead_distribution_settings or users row locks.
--    Thus lock order is strictly: leads (batch upfront) -> lead_distribution_settings -> users (ORDER BY id ASC).
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

    -- Materialize & lock all batch leads upfront in one statement BEFORE touching settings/users locks
    CREATE TEMP TABLE IF NOT EXISTS _tmp_pool_batch (
        id BIGINT,
        version INT,
        pool_attempts INT
    ) ON COMMIT DROP;
    TRUNCATE _tmp_pool_batch;

    INSERT INTO _tmp_pool_batch (id, version, pool_attempts)
    SELECT l.id, l.version, l.pool_attempts
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

REVOKE ALL ON FUNCTION public.fn_assign_lead_atomic(BIGINT, BIGINT, BIGINT, TEXT, INT, BOOLEAN, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_assign_lead_atomic(BIGINT, BIGINT, BIGINT, TEXT, INT, BOOLEAN, INT) TO service_role, postgres;

REVOKE ALL ON FUNCTION public.fn_run_lead_pool_batch(INT, BOOLEAN, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_run_lead_pool_batch(INT, BOOLEAN, TIMESTAMPTZ) TO service_role, postgres;

COMMIT;
