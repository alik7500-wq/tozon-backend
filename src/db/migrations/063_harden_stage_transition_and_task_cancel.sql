-- =============================================================================
-- Migration 063: Harden Stage Transition Fingerprint & Protected Task Cancellation
-- Description:
--   Additive follow-up to 062 (does NOT rewrite 060/061/062 history).
--   1. Replaces pipe-delimited fingerprint with canonical jsonb_build_object(...)
--      including lead_id, target_stage, lost_reason, comment, meeting_at,
--      showing_project_id, showing_at, showing_outcome, actor_user_id, expected_version.
--   2. Restricts LOST task cancellation strictly to open sales tasks (deal_id IS NULL,
--      sales task types only, excluding financial/contract/protected tasks).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_update_lead_stage_atomic(
    p_lead_id BIGINT,
    p_target_stage VARCHAR(50),
    p_lost_reason VARCHAR(50) DEFAULT NULL,
    p_comment TEXT DEFAULT NULL,
    p_actor_user_id BIGINT DEFAULT NULL,
    p_expected_version INT DEFAULT NULL,
    p_idempotency_key VARCHAR(255) DEFAULT NULL,
    p_meeting_at TIMESTAMPTZ DEFAULT NULL,
    p_showing_project_id BIGINT DEFAULT NULL,
    p_showing_at TIMESTAMPTZ DEFAULT NULL,
    p_showing_outcome TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_lead RECORD;
    v_existing_idem RECORD;
    v_fingerprint TEXT;
    v_current_stage VARCHAR(50);
    v_legacy_status VARCHAR(50);
    v_current_order INT;
    v_target_order INT;
    v_new_version INT;
    v_now TIMESTAMPTZ := NOW();
    v_outbox_key VARCHAR(255);
    v_has_signed BOOLEAN := FALSE;
    v_has_reserved BOOLEAN := FALSE;
    v_has_draft BOOLEAN := FALSE;
BEGIN
    IF p_target_stage IS NULL OR p_target_stage NOT IN (
        'NEW', 'IN_PROGRESS', 'NEGOTIATION', 'MEETING_SCHEDULED',
        'SHOWING_DONE', 'RESERVED', 'CONTRACT_PREP', 'SIGNED', 'LOST'
    ) THEN
        RETURN jsonb_build_object(
            'success', false, 'status_code', 400,
            'error_code', 'INVALID_STAGE',
            'message', format('Недопустимый этап воронки: %s', COALESCE(p_target_stage, 'NULL'))
        );
    END IF;

    -- Canonical JSONB fingerprint (sorted keys, unambiguous types & nulls)
    v_fingerprint := md5(jsonb_build_object(
        'lead_id', p_lead_id,
        'target_stage', p_target_stage,
        'lost_reason', p_lost_reason,
        'comment', NULLIF(trim(COALESCE(p_comment, '')), ''),
        'meeting_at', p_meeting_at,
        'showing_project_id', p_showing_project_id,
        'showing_at', p_showing_at,
        'showing_outcome', NULLIF(trim(COALESCE(p_showing_outcome, '')), ''),
        'actor_user_id', p_actor_user_id,
        'expected_version', p_expected_version
    )::text);

    -- 1. Idempotency check under transaction advisory lock
    IF p_idempotency_key IS NOT NULL AND length(trim(p_idempotency_key)) > 0 THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));
        SELECT id, lead_id, to_stage, lead_version, request_fingerprint
        INTO v_existing_idem
        FROM public.lead_stage_history
        WHERE idempotency_key = p_idempotency_key;

        IF FOUND THEN
            IF v_existing_idem.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
                RETURN jsonb_build_object(
                    'success', false, 'status_code', 409,
                    'error_code', 'IDEMPOTENCY_CONFLICT',
                    'message', 'Ключ идемпотентности уже использован для операции с другими параметрами'
                );
            END IF;

            SELECT stage, status, version INTO v_lead FROM public.leads WHERE id = v_existing_idem.lead_id;
            RETURN jsonb_build_object(
                'success', true, 'status', 'REPLAYED', 'replayed', true,
                'lead_id', v_existing_idem.lead_id,
                'stage', COALESCE(v_lead.stage, v_existing_idem.to_stage),
                'version', COALESCE(v_lead.version, v_existing_idem.lead_version)
            );
        END IF;
    END IF;

    -- 2. Lock lead row FOR UPDATE
    SELECT id, status, stage, version, responsible_user_id, archived_at
    INTO v_lead
    FROM public.leads
    WHERE id = p_lead_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false, 'status_code', 404,
            'error_code', 'LEAD_NOT_FOUND', 'message', 'Лид не найден'
        );
    END IF;

    IF v_lead.archived_at IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success', false, 'status_code', 422,
            'error_code', 'LEAD_ARCHIVED', 'message', 'Лид архивирован'
        );
    END IF;

    -- 3. Resolve authoritative current stage from deals + lead
    IF to_regclass('public.deals') IS NOT NULL THEN
        SELECT
            BOOL_OR(status = 'SIGNED'),
            BOOL_OR(status = 'RESERVED'),
            BOOL_OR(status = 'DRAFT')
        INTO v_has_signed, v_has_reserved, v_has_draft
        FROM public.deals
        WHERE lead_id = p_lead_id;
    END IF;

    IF COALESCE(v_has_signed, FALSE) THEN
        v_current_stage := 'SIGNED';
    ELSIF COALESCE(v_has_reserved, FALSE) THEN
        v_current_stage := 'RESERVED';
    ELSIF COALESCE(v_has_draft, FALSE) THEN
        v_current_stage := 'CONTRACT_PREP';
    ELSIF v_lead.status = 'WON' THEN
        v_current_stage := 'CONTRACT_PREP';
    ELSIF v_lead.stage IN ('NEW', 'IN_PROGRESS', 'NEGOTIATION', 'MEETING_SCHEDULED', 'SHOWING_DONE', 'RESERVED', 'CONTRACT_PREP', 'LOST') THEN
        v_current_stage := v_lead.stage;
    ELSIF v_lead.status IN ('IN_PROGRESS', 'NEGOTIATION', 'LOST') THEN
        v_current_stage := v_lead.status;
    ELSE
        v_current_stage := 'NEW';
    END IF;

    -- 4. Atomic CAS version check
    IF p_expected_version IS NOT NULL AND COALESCE(v_lead.version, 1) IS DISTINCT FROM p_expected_version THEN
        RETURN jsonb_build_object(
            'success', false, 'status_code', 409,
            'error_code', 'VERSION_CONFLICT',
            'message', 'Карточка лида была изменена другим пользователем или процессом',
            'current_version', COALESCE(v_lead.version, 1),
            'current_stage', v_current_stage
        );
    END IF;

    -- 5. Business validation (F-02)
    IF v_current_stage = 'SIGNED' THEN
        RETURN jsonb_build_object(
            'success', false, 'status_code', 400,
            'error_code', 'SIGNED_READ_ONLY',
            'message', 'Договор подписан: статус нельзя изменить перетаскиванием. Используйте регламент расторжения.'
        );
    END IF;

    IF p_target_stage = 'SIGNED' THEN
        RETURN jsonb_build_object(
            'success', false, 'status_code', 400,
            'error_code', 'SIGNED_REQUIRES_DEAL',
            'message', 'Этап «Договор подписан» устанавливается только при подтверждении подписанной сделки.'
        );
    END IF;

    IF p_target_stage = 'LOST' THEN
        IF p_lost_reason IS NULL OR p_lost_reason NOT IN (
            'PRICE', 'LOCATION', 'PAYMENT_TERMS', 'NO_RESPONSE', 'CHOSE_COMPETITOR', 'NOT_READY', 'OTHER'
        ) THEN
            RETURN jsonb_build_object(
                'success', false, 'status_code', 400,
                'error_code', 'LOST_REASON_REQUIRED',
                'message', 'При переводе в отказ необходимо указать причину закрытия.'
            );
        END IF;
        IF p_lost_reason = 'OTHER' AND (p_comment IS NULL OR length(trim(p_comment)) = 0) THEN
            RETURN jsonb_build_object(
                'success', false, 'status_code', 400,
                'error_code', 'LOST_COMMENT_REQUIRED',
                'message', 'При выборе причины «Другое» обязателен текстовый комментарий.'
            );
        END IF;
    END IF;

    IF p_target_stage = 'MEETING_SCHEDULED' AND p_meeting_at IS NULL THEN
        RETURN jsonb_build_object(
            'success', false, 'status_code', 400,
            'error_code', 'MEETING_DETAILS_REQUIRED',
            'message', 'Для назначения встречи укажите точные дату и время.'
        );
    END IF;

    IF p_target_stage = 'SHOWING_DONE' AND (
        p_showing_project_id IS NULL OR p_showing_at IS NULL OR p_showing_outcome IS NULL OR length(trim(p_showing_outcome)) = 0
    ) THEN
        RETURN jsonb_build_object(
            'success', false, 'status_code', 400,
            'error_code', 'SHOWING_DETAILS_REQUIRED',
            'message', 'Для фиксации проведённого показа укажите объект/проект, время и результат.'
        );
    END IF;

    v_current_order := CASE v_current_stage
        WHEN 'NEW' THEN 1 WHEN 'IN_PROGRESS' THEN 2 WHEN 'NEGOTIATION' THEN 3
        WHEN 'MEETING_SCHEDULED' THEN 4 WHEN 'SHOWING_DONE' THEN 5 WHEN 'RESERVED' THEN 6
        WHEN 'CONTRACT_PREP' THEN 7 WHEN 'SIGNED' THEN 8 WHEN 'LOST' THEN 9 ELSE 1
    END;
    v_target_order := CASE p_target_stage
        WHEN 'NEW' THEN 1 WHEN 'IN_PROGRESS' THEN 2 WHEN 'NEGOTIATION' THEN 3
        WHEN 'MEETING_SCHEDULED' THEN 4 WHEN 'SHOWING_DONE' THEN 5 WHEN 'RESERVED' THEN 6
        WHEN 'CONTRACT_PREP' THEN 7 WHEN 'SIGNED' THEN 8 WHEN 'LOST' THEN 9 ELSE 1
    END;

    IF v_current_stage <> 'LOST' AND p_target_stage <> 'LOST' AND v_target_order < v_current_order
       AND (p_comment IS NULL OR length(trim(p_comment)) = 0) THEN
        RETURN jsonb_build_object(
            'success', false, 'status_code', 400,
            'error_code', 'BACKWARD_REASON_REQUIRED',
            'message', 'Возврат на предыдущий этап требует указания причины.'
        );
    END IF;

    -- 6. Perform atomic update (never touches first_contact_* or responsible_user_id)
    v_legacy_status := CASE p_target_stage
        WHEN 'NEW' THEN 'NEW'
        WHEN 'IN_PROGRESS' THEN 'IN_PROGRESS'
        WHEN 'LOST' THEN 'LOST'
        WHEN 'SIGNED' THEN 'WON'
        ELSE 'NEGOTIATION'
    END;
    v_new_version := COALESCE(v_lead.version, 1) + 1;

    UPDATE public.leads
    SET status = v_legacy_status,
        stage = p_target_stage,
        version = v_new_version,
        lost_reason = CASE WHEN p_target_stage = 'LOST' THEN p_lost_reason ELSE NULL END,
        lost_reason_code = CASE WHEN p_target_stage = 'LOST' THEN p_lost_reason ELSE NULL END,
        lost_reason_comment = CASE WHEN p_target_stage = 'LOST' THEN p_comment ELSE NULL END,
        updated_at = v_now::TEXT
    WHERE id = p_lead_id
      AND COALESCE(version, 1) = COALESCE(v_lead.version, 1);

    IF NOT FOUND THEN
        RAISE EXCEPTION 'CONCURRENT_MODIFICATION_DETECTED';
    END IF;

    -- 7. Record stage history in the same transaction
    INSERT INTO public.lead_stage_history (
        lead_id, from_stage, to_stage, actor_user_id, reason,
        lead_version, idempotency_key, request_fingerprint, created_at
    ) VALUES (
        p_lead_id, v_current_stage, p_target_stage, p_actor_user_id, COALESCE(p_comment, p_lost_reason),
        v_new_version, NULLIF(trim(COALESCE(p_idempotency_key, '')), ''), v_fingerprint, v_now
    );

    -- 8. Enqueue durable post-processing event in the same transaction (single reliable path)
    v_outbox_key := COALESCE(
        NULLIF(trim(COALESCE(p_idempotency_key, '')), ''),
        format('stage_%s_v%s', p_lead_id, v_new_version)
    );
    INSERT INTO public.crm_event_outbox (
        event_type, aggregate_type, aggregate_id, idempotency_key, payload_json
    ) VALUES (
        CASE WHEN p_target_stage = 'LOST' THEN 'LEAD_LOST' ELSE 'LEAD_STAGE_CHANGED' END,
        'lead',
        p_lead_id::TEXT,
        v_outbox_key,
        jsonb_build_object(
            'lead_id', p_lead_id,
            'from_stage', v_current_stage,
            'to_stage', p_target_stage,
            'actor_user_id', p_actor_user_id,
            'version', v_new_version,
            'lost_reason', p_lost_reason,
            'meeting_at', p_meeting_at,
            'showing_project_id', p_showing_project_id,
            'showing_at', p_showing_at
        )
    )
    ON CONFLICT (idempotency_key) DO NOTHING;

    -- 9. Cancel ONLY open sales tasks on LOST; preserve financial, deal-linked & protected tasks
    IF p_target_stage = 'LOST' THEN
        UPDATE public.tasks
        SET status = 'CANCELLED',
            cancel_reason = COALESCE(NULLIF(trim(COALESCE(p_comment, '')), ''), p_lost_reason, 'Отказ по лиду')
        WHERE lead_id = p_lead_id
          AND status = 'OPEN'
          AND deal_id IS NULL
          AND COALESCE(rule_key, '') NOT IN ('FINANCE_CONTROL', 'CONTRACT_PREP', 'PAYMENT_REMINDER', 'AI_CONFIRMED_STEP')
          AND type IN ('CALL', 'MEETING', 'SHOWING', 'FOLLOW_UP', 'SALES_TASK');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'status', 'UPDATED',
        'replayed', false,
        'lead_id', p_lead_id,
        'from_stage', v_current_stage,
        'stage', p_target_stage,
        'version', v_new_version
    );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_update_lead_stage_atomic(
    BIGINT, VARCHAR, VARCHAR, TEXT, BIGINT, INT, VARCHAR, TIMESTAMPTZ, BIGINT, TIMESTAMPTZ, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_update_lead_stage_atomic(
    BIGINT, VARCHAR, VARCHAR, TEXT, BIGINT, INT, VARCHAR, TIMESTAMPTZ, BIGINT, TIMESTAMPTZ, TEXT
) TO service_role, postgres;

COMMIT;
