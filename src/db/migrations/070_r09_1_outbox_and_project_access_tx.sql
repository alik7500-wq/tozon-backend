-- =============================================================================
-- Migration 070: R09.1 Outbox Recipient Guard, DB Diagnostics & Transactional Project Access
-- Description:
--   1. Hardens fn_apply_outbox_effect so prepared task/notification recipients
--      must match current lead.responsible_user_id in the same transaction.
--   2. Adds fn_set_user_project_access for atomic all-or-nothing replacement of
--      users.all_projects_access and user_project_access rows.
--   3. Adds fn_outbox_diagnostics and fn_outbox_preview_cutoff for exact DB counts.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_apply_outbox_effect(
    p_event_id BIGINT,
    p_lease_token TEXT,
    p_expected_lead_id BIGINT,
    p_expected_assigned_user_id BIGINT DEFAULT NULL,
    p_require_open BOOLEAN DEFAULT TRUE,
    p_tasks JSONB DEFAULT '[]'::jsonb,
    p_notifications JSONB DEFAULT '[]'::jsonb,
    p_rule_executions JSONB DEFAULT '[]'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_event public.crm_event_outbox%ROWTYPE;
    v_lead RECORD;
    v_has_signed_deal BOOLEAN := FALSE;
    v_user RECORD;
    v_has_proj BOOLEAN := FALSE;
    v_task JSONB;
    v_notif JSONB;
    v_exec JSONB;
    v_task_uid BIGINT;
    v_notif_uid BIGINT;
BEGIN
    SELECT * INTO v_event
    FROM public.crm_event_outbox
    WHERE id = p_event_id
      AND status = 'PROCESSING'
      AND lease_token = p_lease_token
      AND lease_expires_at > NOW()
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'code', 'LEASE_LOST');
    END IF;

    SELECT id, full_name, status, stage, responsible_user_id, interested_project_id, archived_at
    INTO v_lead
    FROM public.leads
    WHERE id = p_expected_lead_id
    FOR UPDATE;

    IF NOT FOUND OR v_lead.archived_at IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'skipped', true, 'reason', 'LEAD_ARCHIVED_OR_MISSING');
    END IF;

    SELECT EXISTS(
        SELECT 1 FROM public.deals
        WHERE lead_id = p_expected_lead_id
          AND status = 'SIGNED'
    ) INTO v_has_signed_deal;

    IF p_require_open AND (
        v_has_signed_deal
        OR COALESCE(v_lead.stage, '') IN ('SIGNED', 'LOST')
        OR COALESCE(v_lead.status, '') IN ('WON', 'LOST')
    ) THEN
        RETURN jsonb_build_object('ok', true, 'skipped', true, 'reason', 'LEAD_CLOSED_OR_SIGNED');
    END IF;

    IF p_expected_assigned_user_id IS NOT NULL
       AND v_lead.responsible_user_id IS DISTINCT FROM p_expected_assigned_user_id THEN
        RETURN jsonb_build_object('ok', true, 'skipped', true, 'reason', 'LEAD_REASSIGNED');
    END IF;

    IF (jsonb_array_length(COALESCE(p_tasks, '[]'::jsonb)) > 0
        OR jsonb_array_length(COALESCE(p_notifications, '[]'::jsonb)) > 0) THEN
        IF v_lead.responsible_user_id IS NULL THEN
            RETURN jsonb_build_object('ok', true, 'skipped', true, 'reason', 'NO_RESPONSIBLE_USER');
        END IF;

        -- Verify every prepared task/notification recipient matches current responsible_user_id
        FOR v_task IN SELECT * FROM jsonb_array_elements(COALESCE(p_tasks, '[]'::jsonb))
        LOOP
            v_task_uid := NULLIF(v_task->>'assigned_user_id', '')::BIGINT;
            IF v_task_uid IS NOT NULL AND v_task_uid IS DISTINCT FROM v_lead.responsible_user_id THEN
                RETURN jsonb_build_object('ok', true, 'skipped', true, 'reason', 'RECIPIENT_STALE_REASSIGNED');
            END IF;
        END LOOP;

        FOR v_notif IN SELECT * FROM jsonb_array_elements(COALESCE(p_notifications, '[]'::jsonb))
        LOOP
            v_notif_uid := NULLIF(v_notif->>'user_id', '')::BIGINT;
            IF v_notif_uid IS NOT NULL AND v_notif_uid IS DISTINCT FROM v_lead.responsible_user_id THEN
                RETURN jsonb_build_object('ok', true, 'skipped', true, 'reason', 'RECIPIENT_STALE_REASSIGNED');
            END IF;
        END LOOP;

        SELECT id, is_active, all_projects_access
        INTO v_user
        FROM public.users
        WHERE id = v_lead.responsible_user_id;

        IF NOT FOUND OR COALESCE(v_user.is_active, 0) <> 1 THEN
            RETURN jsonb_build_object('ok', true, 'skipped', true, 'reason', 'USER_INACTIVE');
        END IF;

        IF COALESCE(v_user.all_projects_access, FALSE) THEN
            v_has_proj := TRUE;
        ELSIF v_lead.interested_project_id IS NOT NULL THEN
            SELECT EXISTS(
                SELECT 1 FROM public.user_project_access
                WHERE user_id = v_lead.responsible_user_id
                  AND project_id = v_lead.interested_project_id
                  AND can_view = TRUE
            ) INTO v_has_proj;
        END IF;

        IF NOT v_has_proj THEN
            RETURN jsonb_build_object('ok', true, 'skipped', true, 'reason', 'PROJECT_ACCESS_DENIED');
        END IF;
    END IF;

    FOR v_task IN SELECT * FROM jsonb_array_elements(COALESCE(p_tasks, '[]'::jsonb))
    LOOP
        INSERT INTO public.tasks (
            lead_id, assigned_user_id, created_by, type, priority, title, description,
            due_at, due_date, due_date_only, timezone, status, rule_key, event_ref, idempotency_key
        )
        VALUES (
            p_expected_lead_id,
            v_lead.responsible_user_id,
            NULLIF(v_task->>'created_by', '')::BIGINT,
            COALESCE(NULLIF(v_task->>'type', ''), 'CALL'),
            COALESCE(NULLIF(v_task->>'priority', ''), 'NORMAL'),
            v_task->>'title',
            v_task->>'description',
            NULLIF(v_task->>'due_at', '')::TIMESTAMPTZ,
            v_task->>'due_date',
            COALESCE((v_task->>'due_date_only')::BOOLEAN, FALSE),
            COALESCE(NULLIF(v_task->>'timezone', ''), 'Asia/Dushanbe'),
            'OPEN',
            v_task->>'rule_key',
            v_task->>'event_ref',
            v_task->>'idempotency_key'
        )
        ON CONFLICT (event_ref, rule_key) WHERE event_ref IS NOT NULL AND rule_key IS NOT NULL
        DO NOTHING;
    END LOOP;

    FOR v_notif IN SELECT * FROM jsonb_array_elements(COALESCE(p_notifications, '[]'::jsonb))
    LOOP
        INSERT INTO public.user_notifications (
            user_id, event_type, type, title, message, entity_type, entity_id,
            action_url, dedupe_key, metadata
        )
        VALUES (
            v_lead.responsible_user_id,
            v_notif->>'event_type',
            v_notif->>'event_type',
            v_notif->>'title',
            v_notif->>'message',
            COALESCE(NULLIF(v_notif->>'entity_type', ''), 'lead'),
            p_expected_lead_id,
            v_notif->>'action_url',
            v_notif->>'dedupe_key',
            COALESCE(v_notif->'metadata', '{}'::jsonb)
        )
        ON CONFLICT (dedupe_key) DO NOTHING;
    END LOOP;

    FOR v_exec IN SELECT * FROM jsonb_array_elements(COALESCE(p_rule_executions, '[]'::jsonb))
    LOOP
        INSERT INTO public.crm_automation_executions (
            rule_id, event_key, lead_id, status, error_message
        )
        VALUES (
            (v_exec->>'rule_id')::BIGINT,
            v_exec->>'event_key',
            p_expected_lead_id,
            COALESCE(NULLIF(v_exec->>'status', ''), 'EXECUTED'),
            v_exec->>'error_message'
        )
        ON CONFLICT (rule_id, event_key) DO NOTHING;
    END LOOP;

    RETURN jsonb_build_object('ok', true, 'applied', true);
END;
$$;

-- Transactional replacement of user project access (R04.2 / R09.1)
CREATE OR REPLACE FUNCTION public.fn_set_user_project_access(
    p_user_id BIGINT,
    p_all_projects_access BOOLEAN,
    p_project_ids BIGINT[] DEFAULT ARRAY[]::BIGINT[],
    p_actor_id BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user_id BIGINT;
    v_dedup_ids BIGINT[];
    v_existing_count INT;
    v_pid BIGINT;
BEGIN
    SELECT id INTO v_user_id
    FROM public.users
    WHERE id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'code', 'USER_NOT_FOUND', 'message', 'Пользователь не найден');
    END IF;

    SELECT COALESCE(ARRAY_AGG(DISTINCT x), ARRAY[]::BIGINT[])
    INTO v_dedup_ids
    FROM UNNEST(COALESCE(p_project_ids, ARRAY[]::BIGINT[])) AS x;

    IF ARRAY_LENGTH(v_dedup_ids, 1) > 0 THEN
        SELECT COUNT(*)::INT INTO v_existing_count
        FROM public.projects
        WHERE id = ANY(v_dedup_ids);

        IF v_existing_count <> ARRAY_LENGTH(v_dedup_ids, 1) THEN
            RETURN jsonb_build_object('ok', false, 'code', 'PROJECT_NOT_FOUND', 'message', 'Указан несуществующий объект/проект');
        END IF;
    END IF;

    UPDATE public.users
    SET all_projects_access = p_all_projects_access,
        updated_at = NOW()
    WHERE id = p_user_id;

    DELETE FROM public.user_project_access
    WHERE user_id = p_user_id;

    FOREACH v_pid IN ARRAY v_dedup_ids
    LOOP
        INSERT INTO public.user_project_access (user_id, project_id, can_view, created_by)
        VALUES (p_user_id, v_pid, TRUE, p_actor_id);
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'user_id', p_user_id,
        'all_projects_access', p_all_projects_access,
        'project_ids', to_jsonb(v_dedup_ids)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_set_user_project_access(BIGINT, BOOLEAN, BIGINT[], BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_set_user_project_access(BIGINT, BOOLEAN, BIGINT[], BIGINT) TO service_role;

-- Exact DB-side outbox diagnostics (no 1000-row cap)
CREATE OR REPLACE FUNCTION public.fn_outbox_diagnostics()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_pending BIGINT := 0;
    v_failed BIGINT := 0;
    v_processing BIGINT := 0;
    v_quarantined BIGINT := 0;
    v_oldest TIMESTAMPTZ;
    v_settings JSONB;
    v_recent_q JSONB;
BEGIN
    SELECT
        COUNT(*) FILTER (WHERE status = 'PENDING'),
        COUNT(*) FILTER (WHERE status = 'FAILED'),
        COUNT(*) FILTER (WHERE status = 'PROCESSING'),
        COUNT(*) FILTER (WHERE status = 'QUARANTINED'),
        MIN(created_at) FILTER (WHERE status IN ('PENDING', 'FAILED'))
    INTO v_pending, v_failed, v_processing, v_quarantined, v_oldest
    FROM public.crm_event_outbox;

    SELECT to_jsonb(s) INTO v_settings
    FROM public.crm_outbox_settings s
    WHERE s.id = 1;

    SELECT COALESCE(jsonb_agg(row_to_json(q)::jsonb), '[]'::jsonb)
    INTO v_recent_q
    FROM (
        SELECT id, event_type, aggregate_id, status, attempts, max_attempts, error_kind, quarantine_reason, created_at
        FROM public.crm_event_outbox
        WHERE status = 'QUARANTINED'
        ORDER BY created_at DESC, id DESC
        LIMIT 20
    ) q;

    RETURN jsonb_build_object(
        'queueSize', v_pending + v_failed,
        'pendingCount', v_pending,
        'failedCount', v_failed,
        'processingCount', v_processing,
        'quarantinedCount', v_quarantined,
        'oldestPendingAgeSeconds', CASE WHEN v_oldest IS NULL THEN 0 ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - v_oldest)))::BIGINT) END,
        'settings', v_settings,
        'recentQuarantined', v_recent_q
    );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_outbox_diagnostics() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_outbox_diagnostics() TO service_role;

CREATE OR REPLACE FUNCTION public.fn_outbox_preview_cutoff(p_cutoff_at TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_eligible BIGINT := 0;
    v_skipped BIGINT := 0;
BEGIN
    SELECT
        COUNT(*) FILTER (WHERE created_at >= p_cutoff_at),
        COUNT(*) FILTER (WHERE created_at < p_cutoff_at)
    INTO v_eligible, v_skipped
    FROM public.crm_event_outbox
    WHERE status IN ('PENDING', 'FAILED');

    RETURN jsonb_build_object(
        'cutoffAt', p_cutoff_at,
        'eligibleCount', v_eligible,
        'skippedHistoricalCount', v_skipped
    );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_outbox_preview_cutoff(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_outbox_preview_cutoff(TIMESTAMPTZ) TO service_role;

COMMIT;
