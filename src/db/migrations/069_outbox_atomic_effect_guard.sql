-- =============================================================================
-- Migration 069: Atomic Outbox Effect Guard & Historical Import Policy (R08.1)
-- Description:
--   1. Adds process_historical_import BOOLEAN NOT NULL DEFAULT FALSE to crm_outbox_settings.
--   2. Adds public.fn_apply_outbox_effect(...) which atomically checks in ONE transaction:
--      - active lease_token & lease_expires_at > NOW()
--      - lead existence & not archived
--      - authoritative closure via deals (SIGNED deal) + leads.stage/status
--      - expected responsible_user_id & user active + project access
--      and writes idempotent tasks, user_notifications, and crm_automation_executions.
-- =============================================================================

BEGIN;

ALTER TABLE public.crm_outbox_settings
    ADD COLUMN IF NOT EXISTS process_historical_import BOOLEAN NOT NULL DEFAULT FALSE;

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
BEGIN
    -- 1. Verify active lease inside the same transaction as effect writes
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

    -- 2. Lock and verify current authoritative lead state
    SELECT id, full_name, status, stage, responsible_user_id, interested_project_id, archived_at
    INTO v_lead
    FROM public.leads
    WHERE id = p_expected_lead_id
    FOR UPDATE;

    IF NOT FOUND OR v_lead.archived_at IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'skipped', true, 'reason', 'LEAD_ARCHIVED_OR_MISSING');
    END IF;

    -- 3. Authoritative closure check including related SIGNED deals
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

    -- 4. Verify active user & project access if tasks/notifications target responsible user
    IF (jsonb_array_length(COALESCE(p_tasks, '[]'::jsonb)) > 0
        OR jsonb_array_length(COALESCE(p_notifications, '[]'::jsonb)) > 0) THEN
        IF v_lead.responsible_user_id IS NULL THEN
            RETURN jsonb_build_object('ok', true, 'skipped', true, 'reason', 'NO_RESPONSIBLE_USER');
        END IF;

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

    -- 5. Idempotently insert tasks
    FOR v_task IN SELECT * FROM jsonb_array_elements(COALESCE(p_tasks, '[]'::jsonb))
    LOOP
        INSERT INTO public.tasks (
            lead_id, assigned_user_id, created_by, type, priority, title, description,
            due_at, due_date, due_date_only, timezone, status, rule_key, event_ref, idempotency_key
        )
        VALUES (
            p_expected_lead_id,
            COALESCE(NULLIF(v_task->>'assigned_user_id', '')::BIGINT, v_lead.responsible_user_id),
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

    -- 6. Idempotently insert in-app notifications
    FOR v_notif IN SELECT * FROM jsonb_array_elements(COALESCE(p_notifications, '[]'::jsonb))
    LOOP
        INSERT INTO public.user_notifications (
            user_id, event_type, type, title, message, entity_type, entity_id,
            action_url, dedupe_key, metadata
        )
        VALUES (
            COALESCE(NULLIF(v_notif->>'user_id', '')::BIGINT, v_lead.responsible_user_id),
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

    -- 7. Record rule executions (errors roll back the entire transaction)
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

REVOKE ALL ON FUNCTION public.fn_apply_outbox_effect(BIGINT, TEXT, BIGINT, BIGINT, BOOLEAN, JSONB, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_apply_outbox_effect(BIGINT, TEXT, BIGINT, BIGINT, BOOLEAN, JSONB, JSONB, JSONB) TO service_role;

COMMIT;
