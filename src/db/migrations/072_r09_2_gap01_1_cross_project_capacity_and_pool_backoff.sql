-- Migration 072: GAP-01.1 Cross-Project Capacity Lock, Canonical Open Stages, Safe Unassigned Settings & Pool Backoff
-- Additive migration only. Preserves closed EXECUTE grants and fixed search_path.

BEGIN;

-- 1. Pool backoff columns & partial index to prevent pool starvation
ALTER TABLE public.leads
    ADD COLUMN IF NOT EXISTS pool_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS pool_attempts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_leads_pool_due
    ON public.leads(pool_next_attempt_at ASC, created_at ASC, id ASC)
    WHERE responsible_user_id IS NULL AND archived_at IS NULL;

-- 2. Harden fn_select_and_assign_lead_atomic:
--    - Safe v_has_settings check (no SQL error when lead has no project and global settings row is missing)
--    - Unified lock order: leads -> lead_distribution_settings -> candidate users (ORDER BY u.id ASC FOR UPDATE)
--      preventing cross-project capacity races and deadlocks
--    - Canonical open-lead workload count (excluding LOST, SIGNED, archived, and leads with SIGNED deals)
CREATE OR REPLACE FUNCTION public.fn_select_and_assign_lead_atomic(
    p_lead_id BIGINT,
    p_actor_user_id BIGINT DEFAULT NULL,
    p_expected_version INT DEFAULT NULL,
    p_assignment_source TEXT DEFAULT 'AUTO',
    p_now TIMESTAMPTZ DEFAULT NOW()
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_lead RECORD;
    v_settings RECORD;
    v_has_settings BOOLEAN := FALSE;
    v_has_signed_deal BOOLEAN := FALSE;
    v_local_ts TIMESTAMP;
    v_iso_dow INT;
    v_hour INT;
    v_work_days_ok BOOLEAN := TRUE;
    v_start_hour INT;
    v_end_hour INT;
    v_selected RECORD;
    v_new_version INT;
    v_reason TEXT;
    v_cursor BIGINT;
    v_min_workload INT;
    v_pool_reason TEXT;
BEGIN
    -- Lock order 1: leads row
    SELECT id, status, stage, version, responsible_user_id, interested_project_id, archived_at, is_historical_import
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
        RETURN jsonb_build_object('success', true, 'status', 'SKIPPED_ARCHIVED', 'lead_id', p_lead_id);
    END IF;

    IF v_lead.status = 'LOST' OR COALESCE(v_lead.stage, v_lead.status) IN ('LOST', 'SIGNED') THEN
        RETURN jsonb_build_object('success', true, 'status', 'SKIPPED_TERMINAL_STAGE', 'lead_id', p_lead_id);
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.deals d WHERE d.lead_id = p_lead_id AND d.status = 'SIGNED'
    ) INTO v_has_signed_deal;

    IF v_has_signed_deal THEN
        RETURN jsonb_build_object('success', true, 'status', 'SKIPPED_SIGNED_DEAL', 'lead_id', p_lead_id);
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

    IF v_lead.responsible_user_id IS NOT NULL AND v_lead.responsible_user_id > 0 THEN
        RETURN jsonb_build_object(
            'success', true,
            'status', 'PRESERVED_EXISTING',
            'lead_id', p_lead_id,
            'responsible_user_id', v_lead.responsible_user_id,
            'version', v_lead.version
        );
    END IF;

    -- Lock order 2: lead_distribution_settings (project-scoped, fallback to global)
    IF v_lead.interested_project_id IS NOT NULL THEN
        SELECT *
        INTO v_settings
        FROM public.lead_distribution_settings
        WHERE project_id = v_lead.interested_project_id
        FOR UPDATE;
        IF FOUND THEN
            v_has_settings := TRUE;
        END IF;
    END IF;

    IF NOT v_has_settings THEN
        SELECT *
        INTO v_settings
        FROM public.lead_distribution_settings
        WHERE project_id IS NULL
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE;
        IF FOUND THEN
            v_has_settings := TRUE;
        END IF;
    END IF;

    IF NOT v_has_settings THEN
        v_pool_reason := 'SETTINGS_UNAVAILABLE';
        UPDATE public.leads
        SET pool_reason = v_pool_reason,
            updated_at = p_now::TEXT
        WHERE id = p_lead_id;

        RETURN jsonb_build_object(
            'success', true,
            'status', 'POOLED',
            'lead_id', p_lead_id,
            'pool_reason', v_pool_reason
        );
    END IF;

    IF v_settings.enabled IS NOT TRUE THEN
        v_pool_reason := 'DISTRIBUTION_DISABLED';
        UPDATE public.leads
        SET pool_reason = v_pool_reason,
            updated_at = p_now::TEXT
        WHERE id = p_lead_id;

        RETURN jsonb_build_object(
            'success', true,
            'status', 'POOLED',
            'lead_id', p_lead_id,
            'pool_reason', v_pool_reason
        );
    END IF;

    -- Working calendar check in Asia/Dushanbe
    IF COALESCE(v_settings.working_hours_only, TRUE) THEN
        v_local_ts := p_now AT TIME ZONE 'Asia/Dushanbe';
        v_iso_dow := EXTRACT(ISODOW FROM v_local_ts)::INT;
        v_hour := EXTRACT(HOUR FROM v_local_ts)::INT;
        v_start_hour := COALESCE(v_settings.work_start_hour, 8);
        v_end_hour := COALESCE(v_settings.work_end_hour, 20);

        IF v_settings.work_days_json IS NOT NULL AND jsonb_typeof(v_settings.work_days_json) = 'array' THEN
            SELECT EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(v_settings.work_days_json) AS d(val)
                WHERE d.val::INT = v_iso_dow OR (v_iso_dow = 7 AND d.val::INT = 0)
            ) INTO v_work_days_ok;
        END IF;

        IF NOT v_work_days_ok OR v_hour < v_start_hour OR v_hour >= v_end_hour THEN
            v_pool_reason := 'OUTSIDE_WORKING_HOURS';
            UPDATE public.leads
            SET pool_reason = v_pool_reason,
                updated_at = p_now::TEXT
            WHERE id = p_lead_id;

            RETURN jsonb_build_object(
                'success', true,
                'status', 'POOLED',
                'lead_id', p_lead_id,
                'pool_reason', v_pool_reason
            );
        END IF;
    END IF;

    v_cursor := COALESCE(v_settings.round_robin_cursor, 0);

    -- Lock order 3: Lock all eligible candidate user rows in deterministic ID order (prevents cross-project capacity race & deadlocks)
    PERFORM 1
    FROM public.users u
    WHERE u.is_active = 1
      AND u.is_sales_rep IS TRUE
      AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(COALESCE(v_settings.excluded_user_ids, '[]'::jsonb)) AS ex(val)
          WHERE ex.val ~ '^[0-9]+$' AND ex.val::BIGINT = u.id
      )
      AND (
          v_settings.allowed_user_ids IS NULL
          OR jsonb_typeof(v_settings.allowed_user_ids) <> 'array'
          OR jsonb_array_length(v_settings.allowed_user_ids) = 0
          OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(v_settings.allowed_user_ids) AS al(val)
              WHERE al.val ~ '^[0-9]+$' AND al.val::BIGINT = u.id
          )
      )
      AND (
          CASE
              WHEN v_lead.interested_project_id IS NOT NULL THEN
                  COALESCE(u.all_projects_access, FALSE) IS TRUE
                  OR EXISTS (
                      SELECT 1
                      FROM public.user_project_access upa
                      WHERE upa.user_id = u.id
                        AND upa.project_id = v_lead.interested_project_id
                        AND upa.can_view IS TRUE
                  )
              ELSE
                  COALESCE(u.all_projects_access, FALSE) IS TRUE
          END
      )
    ORDER BY u.id ASC
    FOR UPDATE;

    -- Build candidate workload table AFTER acquiring user row locks
    CREATE TEMP TABLE IF NOT EXISTS _tmp_rr_candidates (
        id BIGINT,
        name TEXT,
        open_count INT
    ) ON COMMIT DROP;
    TRUNCATE _tmp_rr_candidates;

    INSERT INTO _tmp_rr_candidates (id, name, open_count)
    SELECT
        u.id,
        u.name,
        (
            SELECT COUNT(*)::INT
            FROM public.leads l
            WHERE l.responsible_user_id = u.id
              AND l.archived_at IS NULL
              AND l.status <> 'LOST'
              AND COALESCE(l.stage, l.status) NOT IN ('LOST', 'SIGNED')
              AND NOT EXISTS (
                  SELECT 1
                  FROM public.deals d
                  WHERE d.lead_id = l.id
                    AND d.status = 'SIGNED'
              )
        ) AS open_count
    FROM public.users u
    WHERE u.is_active = 1
      AND u.is_sales_rep IS TRUE
      AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(COALESCE(v_settings.excluded_user_ids, '[]'::jsonb)) AS ex(val)
          WHERE ex.val ~ '^[0-9]+$' AND ex.val::BIGINT = u.id
      )
      AND (
          v_settings.allowed_user_ids IS NULL
          OR jsonb_typeof(v_settings.allowed_user_ids) <> 'array'
          OR jsonb_array_length(v_settings.allowed_user_ids) = 0
          OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(v_settings.allowed_user_ids) AS al(val)
              WHERE al.val ~ '^[0-9]+$' AND al.val::BIGINT = u.id
          )
      )
      AND (
          CASE
              WHEN v_lead.interested_project_id IS NOT NULL THEN
                  COALESCE(u.all_projects_access, FALSE) IS TRUE
                  OR EXISTS (
                      SELECT 1
                      FROM public.user_project_access upa
                      WHERE upa.user_id = u.id
                        AND upa.project_id = v_lead.interested_project_id
                        AND upa.can_view IS TRUE
                  )
              ELSE
                  COALESCE(u.all_projects_access, FALSE) IS TRUE
          END
      );

    DELETE FROM _tmp_rr_candidates
    WHERE open_count >= COALESCE(v_settings.max_open_leads_per_rep, 25);

    IF NOT EXISTS (SELECT 1 FROM _tmp_rr_candidates) THEN
        v_pool_reason := 'NO_ELIGIBLE_REPS';
        UPDATE public.leads
        SET pool_reason = v_pool_reason,
            updated_at = p_now::TEXT
        WHERE id = p_lead_id;

        RETURN jsonb_build_object(
            'success', true,
            'status', 'POOLED',
            'lead_id', p_lead_id,
            'pool_reason', v_pool_reason
        );
    END IF;

    IF COALESCE(v_settings.algorithm, 'LEAST_LOADED') = 'ROUND_ROBIN' THEN
        SELECT id, name, open_count
        INTO v_selected
        FROM _tmp_rr_candidates
        WHERE id > v_cursor
        ORDER BY id ASC
        LIMIT 1;

        IF NOT FOUND THEN
            SELECT id, name, open_count
            INTO v_selected
            FROM _tmp_rr_candidates
            ORDER BY id ASC
            LIMIT 1;
        END IF;
    ELSE
        SELECT MIN(open_count) INTO v_min_workload FROM _tmp_rr_candidates;

        SELECT id, name, open_count
        INTO v_selected
        FROM _tmp_rr_candidates
        WHERE open_count = v_min_workload
          AND id > v_cursor
        ORDER BY id ASC
        LIMIT 1;

        IF NOT FOUND THEN
            SELECT id, name, open_count
            INTO v_selected
            FROM _tmp_rr_candidates
            WHERE open_count = v_min_workload
            ORDER BY id ASC
            LIMIT 1;
        END IF;
    END IF;

    UPDATE public.lead_distribution_settings
    SET round_robin_cursor = v_selected.id,
        updated_at = p_now
    WHERE id = v_settings.id;

    v_new_version := COALESCE(v_lead.version, 1) + 1;
    v_reason := format(
        'Автоматическое распределение (%s, %s) менеджеру %s',
        COALESCE(v_settings.algorithm, 'LEAST_LOADED'),
        COALESCE(p_assignment_source, 'AUTO'),
        v_selected.name
    );

    UPDATE public.leads
    SET responsible_user_id = v_selected.id,
        assigned_at = p_now,
        pool_reason = NULL,
        pool_attempts = 0,
        pool_next_attempt_at = p_now,
        reassignment_reason = v_reason,
        version = v_new_version,
        updated_at = p_now::TEXT
    WHERE id = p_lead_id;

    INSERT INTO public.lead_assignment_history (
        lead_id, from_user_id, to_user_id, assigned_by_user_id, assignment_type, reason, created_at
    ) VALUES (
        p_lead_id,
        NULL,
        v_selected.id,
        p_actor_user_id,
        CASE WHEN p_assignment_source = 'POOL_WORKER' THEN 'POOL_WORKER' ELSE 'ROUND_ROBIN' END,
        v_reason,
        p_now
    );

    RETURN jsonb_build_object(
        'success', true,
        'status', 'ASSIGNED',
        'lead_id', p_lead_id,
        'to_user_id', v_selected.id,
        'to_user_name', v_selected.name,
        'version', v_new_version,
        'assigned_at', p_now,
        'algorithm', COALESCE(v_settings.algorithm, 'LEAST_LOADED'),
        'cursor', v_selected.id,
        'settings_id', v_settings.id
    );
END;
$$;

-- 3. Align fn_assign_lead_atomic capacity count with canonical open stages & SIGNED deals
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

-- 4. Update fn_run_lead_pool_batch with pool_next_attempt_at backoff to prevent starvation
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

    FOR v_lead IN
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
        FOR UPDATE OF l SKIP LOCKED
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

REVOKE ALL ON FUNCTION public.fn_select_and_assign_lead_atomic(BIGINT, BIGINT, INT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_select_and_assign_lead_atomic(BIGINT, BIGINT, INT, TEXT, TIMESTAMPTZ) TO service_role, postgres;

REVOKE ALL ON FUNCTION public.fn_assign_lead_atomic(BIGINT, BIGINT, BIGINT, TEXT, INT, BOOLEAN, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_assign_lead_atomic(BIGINT, BIGINT, BIGINT, TEXT, INT, BOOLEAN, INT) TO service_role, postgres;

REVOKE ALL ON FUNCTION public.fn_run_lead_pool_batch(INT, BOOLEAN, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_run_lead_pool_batch(INT, BOOLEAN, TIMESTAMPTZ) TO service_role, postgres;

COMMIT;
