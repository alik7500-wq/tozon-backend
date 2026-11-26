-- =============================================================================
-- Migration 064: Unified DB-side Lead Filtering, Totals, Stage Counts & Keyset Cursor
-- Description:
--   Additive migration (does NOT rewrite 060-063 history).
--   Implements public.fn_query_leads_unified(p_filters JSONB, p_scope JSONB)
--   so listing, kanban column totals, stats, and export execute the exact same
--   DB-side filtering, Asia/Dushanbe [from, to) timezone conversion, due_at /
--   date-only overdue calculation, deal-authoritative canonical stage resolution,
--   and stable keyset cursor pagination (created_at DESC, id DESC) without
--   loading all rows into Node.js or multiplying rows on JOINs.
-- =============================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_leads_created_at_id_desc
    ON public.leads(created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.fn_query_leads_unified(
    p_filters JSONB DEFAULT '{}'::jsonb,
    p_scope JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_role TEXT := UPPER(COALESCE(p_scope->>'role', ''));
    v_user_id BIGINT := NULLIF(p_scope->>'user_id', '')::BIGINT;
    v_restricted BOOLEAN := COALESCE((p_scope->>'restricted_to_self')::BOOLEAN, v_role NOT IN ('ADMIN', 'DIRECTOR'));
    v_limit INT := LEAST(GREATEST(COALESCE((p_filters->>'limit')::INT, 50), 0), 500);
    v_cursor_ts TIMESTAMPTZ := NULLIF(p_filters->>'cursor_created_at', '')::TIMESTAMPTZ;
    v_cursor_id BIGINT := NULLIF(p_filters->>'cursor_id', '')::BIGINT;
    v_archive TEXT := COALESCE(NULLIF(p_filters->>'archive', ''), 'active');
    v_project_id BIGINT := NULLIF(p_filters->>'project_id', '')::BIGINT;
    v_manager_id BIGINT := NULLIF(p_filters->>'manager_id', '')::BIGINT;
    v_source TEXT := NULLIF(UPPER(trim(COALESCE(p_filters->>'source', ''))), '');
    v_account_id TEXT := NULLIF(trim(COALESCE(p_filters->>'account_id', '')), '');
    v_stage TEXT := NULLIF(UPPER(trim(COALESCE(p_filters->>'stage', ''))), '');
    v_task_state TEXT := NULLIF(UPPER(trim(COALESCE(p_filters->>'task_state', ''))), '');
    v_lost_reason TEXT := NULLIF(UPPER(trim(COALESCE(p_filters->>'lost_reason', ''))), '');
    v_quick_filter TEXT := NULLIF(UPPER(trim(COALESCE(p_filters->>'quick_filter', ''))), '');
    v_search TEXT := NULLIF(trim(COALESCE(p_filters->>'search', '')), '');
    v_unread BOOLEAN := CASE
        WHEN p_filters ? 'unread' AND p_filters->>'unread' IN ('true', 'false')
        THEN (p_filters->>'unread')::BOOLEAN
        ELSE NULL
    END;
    v_from_raw TEXT := NULLIF(trim(COALESCE(p_filters->>'created_from', '')), '');
    v_to_raw TEXT := NULLIF(trim(COALESCE(p_filters->>'created_to', '')), '');
    v_from_utc TIMESTAMPTZ;
    v_to_utc TIMESTAMPTZ;
    v_total BIGINT := 0;
    v_stats JSONB;
    v_stage_counts JSONB;
    v_rows JSONB;
BEGIN
    -- Explicit Asia/Dushanbe calendar boundary conversion to UTC [from, to)
    IF v_from_raw IS NOT NULL THEN
        IF v_from_raw ~ '^\d{4}-\d{2}-\d{2}$' THEN
            v_from_utc := (v_from_raw::date::timestamp AT TIME ZONE 'Asia/Dushanbe');
        ELSE
            v_from_utc := v_from_raw::timestamptz;
        END IF;
    END IF;

    IF v_to_raw IS NOT NULL THEN
        IF v_to_raw ~ '^\d{4}-\d{2}-\d{2}$' THEN
            -- Exclusive upper bound: next calendar day 00:00 Asia/Dushanbe
            v_to_utc := ((v_to_raw::date + 1)::timestamp AT TIME ZONE 'Asia/Dushanbe');
        ELSE
            v_to_utc := v_to_raw::timestamptz;
        END IF;
    END IF;

    CREATE TEMP TABLE tmp_filtered_leads ON COMMIT DROP AS
    WITH base AS (
        SELECT
            l.id,
            l.full_name,
            l.phone,
            l.secondary_phone,
            l.source,
            l.source_code,
            l.status,
            l.stage AS stored_stage,
            l.version,
            l.responsible_user_id,
            u.name AS responsible_user_name,
            l.interested_project_id,
            p.name AS interested_project_name,
            l.budget_min_minor,
            l.budget_max_minor,
            l.notes,
            l.assigned_at,
            l.first_contact_at,
            l.first_human_action_at,
            l.first_response_at,
            l.first_contact_confirmed_at,
            l.first_contact_origin,
            l.last_inbound_at,
            COALESCE(l.unread_count, 0) AS unread_count,
            l.pause_until,
            l.pause_reason,
            l.pool_reason,
            l.lost_reason_code,
            l.lost_reason,
            l.archived_at,
            NULLIF(trim(l.created_at), '')::timestamptz AS created_at_ts,
            l.created_at,
            l.updated_at,
            -- Authoritative canonical stage via deals (no row multiplication)
            CASE
                WHEN to_regclass('public.deals') IS NOT NULL AND EXISTS (
                    SELECT 1 FROM public.deals d WHERE d.lead_id = l.id AND d.status = 'SIGNED'
                ) THEN 'SIGNED'
                WHEN to_regclass('public.deals') IS NOT NULL AND EXISTS (
                    SELECT 1 FROM public.deals d WHERE d.lead_id = l.id AND d.status = 'RESERVED'
                ) THEN 'RESERVED'
                WHEN to_regclass('public.deals') IS NOT NULL AND EXISTS (
                    SELECT 1 FROM public.deals d WHERE d.lead_id = l.id AND d.status = 'DRAFT'
                ) THEN 'CONTRACT_PREP'
                WHEN l.status = 'WON' THEN 'CONTRACT_PREP'
                WHEN l.stage IN ('NEW', 'IN_PROGRESS', 'NEGOTIATION', 'MEETING_SCHEDULED', 'SHOWING_DONE', 'RESERVED', 'CONTRACT_PREP', 'LOST') THEN l.stage
                WHEN l.status IN ('IN_PROGRESS', 'NEGOTIATION', 'LOST') THEN l.status
                ELSE 'NEW'
            END AS canonical_stage,
            (l.status = 'WON' AND (
                to_regclass('public.deals') IS NULL OR NOT EXISTS (
                    SELECT 1 FROM public.deals d WHERE d.lead_id = l.id AND d.status = 'SIGNED'
                )
            )) AS legacy_unverified_won,
            -- Task state without row multiplication
            EXISTS (
                SELECT 1 FROM public.tasks t WHERE t.lead_id = l.id AND t.status = 'OPEN'
            ) AS has_open_task,
            EXISTS (
                SELECT 1 FROM public.tasks t
                WHERE t.lead_id = l.id
                  AND t.status = 'OPEN'
                  AND (
                      (t.due_at IS NOT NULL AND t.due_at < NOW())
                      OR (
                          t.due_at IS NULL AND t.due_date IS NOT NULL
                          AND ((t.due_date::date::timestamp + time '18:00:00') AT TIME ZONE COALESCE(NULLIF(t.timezone, ''), 'Asia/Dushanbe')) < NOW()
                      )
                  )
            ) AS has_overdue_task,
            (l.pause_until IS NOT NULL AND l.pause_until > NOW()) AS is_paused,
            -- Account match from contacts if linked
            c.instagram_account_id AS contact_account_id,
            (
                SELECT COUNT(*)::int FROM public.lead_communications lc
                WHERE lc.lead_id = l.id AND lc.direction = 'INBOUND'
            ) AS inbound_count
        FROM public.leads l
        LEFT JOIN public.users u ON u.id = l.responsible_user_id
        LEFT JOIN public.projects p ON p.id = l.interested_project_id
        LEFT JOIN public.contacts c ON c.id = l.contact_id
        WHERE 1=1
          -- Hard RBAC enforcement inside DB query
          AND (NOT v_restricted OR (l.responsible_user_id IS NOT NULL AND l.responsible_user_id = v_user_id))
          AND (
              NOT (p_scope ? 'allowed_project_ids')
              OR jsonb_array_length(p_scope->'allowed_project_ids') = 0
              OR l.interested_project_id = ANY (
                  SELECT (elem#>>'{}')::BIGINT FROM jsonb_array_elements(p_scope->'allowed_project_ids') AS elem
              )
          )
    )
    SELECT *
    FROM base b
    WHERE
        -- Archive filter
        (
            (v_archive = 'active' AND b.archived_at IS NULL)
            OR (v_archive = 'archived' AND b.archived_at IS NOT NULL)
            OR (v_archive = 'all')
        )
        -- Project, Manager, Source, Account
        AND (v_project_id IS NULL OR b.interested_project_id = v_project_id)
        AND (v_manager_id IS NULL OR b.responsible_user_id = v_manager_id)
        AND (v_source IS NULL OR UPPER(COALESCE(b.source_code, b.source, '')) = v_source)
        AND (v_account_id IS NULL OR b.contact_account_id = v_account_id)
        -- Canonical stage
        AND (v_stage IS NULL OR b.canonical_stage = v_stage)
        -- Lost reason
        AND (v_lost_reason IS NULL OR UPPER(COALESCE(b.lost_reason_code, b.lost_reason, '')) = v_lost_reason)
        -- Unread
        AND (v_unread IS NULL OR (v_unread = TRUE AND b.unread_count > 0) OR (v_unread = FALSE AND b.unread_count = 0))
        -- Created period [from, to)
        AND (v_from_utc IS NULL OR b.created_at_ts >= v_from_utc)
        AND (v_to_utc IS NULL OR b.created_at_ts < v_to_utc)
        -- Search
        AND (
            v_search IS NULL
            OR b.full_name ILIKE '%' || v_search || '%'
            OR COALESCE(b.phone, '') ILIKE '%' || v_search || '%'
            OR COALESCE(b.secondary_phone, '') ILIKE '%' || v_search || '%'
            OR b.id::text = v_search
        )
        -- Task state (distinct: NO_TASK vs PAUSED vs HAS_OPEN vs OVERDUE)
        AND (
            v_task_state IS NULL
            OR (v_task_state = 'NO_TASK' AND b.canonical_stage NOT IN ('SIGNED', 'LOST') AND NOT b.has_open_task AND NOT b.is_paused)
            OR (v_task_state = 'PAUSED' AND b.canonical_stage NOT IN ('SIGNED', 'LOST') AND b.is_paused)
            OR (v_task_state = 'HAS_OPEN' AND b.has_open_task)
            OR (v_task_state = 'OVERDUE' AND b.canonical_stage NOT IN ('SIGNED', 'LOST') AND b.has_overdue_task)
        )
        -- Quick filters
        AND (
            v_quick_filter IS NULL OR v_quick_filter = 'ALL'
            OR (v_quick_filter = 'MY' AND b.responsible_user_id = v_user_id)
            OR (v_quick_filter = 'NEW' AND b.canonical_stage = 'NEW')
            OR (v_quick_filter = 'UNASSIGNED' AND b.responsible_user_id IS NULL AND b.canonical_stage NOT IN ('SIGNED', 'LOST'))
            OR (v_quick_filter = 'AWAITING_RESPONSE' AND b.canonical_stage NOT IN ('SIGNED', 'LOST') AND b.first_response_at IS NULL AND (b.first_contact_at IS NULL OR b.first_contact_origin = 'STAGE_ADVANCED'))
            OR (v_quick_filter = 'NO_TASK' AND b.canonical_stage NOT IN ('SIGNED', 'LOST') AND NOT b.has_open_task AND NOT b.is_paused)
            OR (v_quick_filter = 'OVERDUE' AND b.canonical_stage NOT IN ('SIGNED', 'LOST') AND b.has_overdue_task)
            OR (v_quick_filter = 'UNREAD' AND b.unread_count > 0)
            OR (v_quick_filter = 'REPEAT' AND b.inbound_count > 1)
            OR (v_quick_filter = 'CLOSED' AND b.canonical_stage IN ('SIGNED', 'LOST'))
            OR (v_quick_filter = 'IN_PROGRESS' AND b.canonical_stage IN ('IN_PROGRESS', 'NEGOTIATION', 'MEETING_SCHEDULED', 'SHOWING_DONE', 'RESERVED', 'CONTRACT_PREP'))
        );

    -- Full total and aggregates over ALL matching rows (before LIMIT)
    SELECT
        COUNT(*)::BIGINT,
        jsonb_build_object(
            'total', COUNT(*)::BIGINT,
            'new', COUNT(*) FILTER (WHERE canonical_stage = 'NEW'),
            'unassigned', COUNT(*) FILTER (WHERE responsible_user_id IS NULL AND canonical_stage NOT IN ('SIGNED', 'LOST')),
            'awaiting_contact', COUNT(*) FILTER (WHERE canonical_stage NOT IN ('SIGNED', 'LOST') AND first_response_at IS NULL AND (first_contact_at IS NULL OR first_contact_origin = 'STAGE_ADVANCED')),
            'overdue', COUNT(*) FILTER (WHERE canonical_stage NOT IN ('SIGNED', 'LOST') AND has_overdue_task),
            'in_progress', COUNT(*) FILTER (WHERE canonical_stage IN ('IN_PROGRESS', 'NEGOTIATION', 'MEETING_SCHEDULED', 'SHOWING_DONE', 'RESERVED', 'CONTRACT_PREP')),
            'closed', COUNT(*) FILTER (WHERE canonical_stage IN ('SIGNED', 'LOST')),
            'no_task', COUNT(*) FILTER (WHERE canonical_stage NOT IN ('SIGNED', 'LOST') AND NOT has_open_task AND NOT is_paused),
            'unread', COUNT(*) FILTER (WHERE unread_count > 0)
        ),
        jsonb_build_object(
            'NEW', COUNT(*) FILTER (WHERE canonical_stage = 'NEW'),
            'IN_PROGRESS', COUNT(*) FILTER (WHERE canonical_stage = 'IN_PROGRESS'),
            'NEGOTIATION', COUNT(*) FILTER (WHERE canonical_stage = 'NEGOTIATION'),
            'MEETING_SCHEDULED', COUNT(*) FILTER (WHERE canonical_stage = 'MEETING_SCHEDULED'),
            'SHOWING_DONE', COUNT(*) FILTER (WHERE canonical_stage = 'SHOWING_DONE'),
            'RESERVED', COUNT(*) FILTER (WHERE canonical_stage = 'RESERVED'),
            'CONTRACT_PREP', COUNT(*) FILTER (WHERE canonical_stage = 'CONTRACT_PREP'),
            'SIGNED', COUNT(*) FILTER (WHERE canonical_stage = 'SIGNED'),
            'LOST', COUNT(*) FILTER (WHERE canonical_stage = 'LOST')
        )
    INTO v_total, v_stats, v_stage_counts
    FROM tmp_filtered_leads;

    -- Keyset paginated rows (created_at_ts DESC, id DESC)
    IF v_limit = 0 THEN
        v_rows := '[]'::jsonb;
    ELSE
        SELECT COALESCE(jsonb_agg(row_to_json(paged)::jsonb), '[]'::jsonb)
        INTO v_rows
        FROM (
            SELECT
                id::text AS id_str,
                id,
                full_name,
                phone,
                secondary_phone,
                source,
                source_code,
                status,
                canonical_stage AS stage,
                version,
                responsible_user_id,
                responsible_user_name,
                interested_project_id,
                interested_project_name,
                budget_min_minor,
                budget_max_minor,
                notes,
                assigned_at,
                first_contact_at,
                first_human_action_at,
                first_response_at,
                first_contact_confirmed_at,
                last_inbound_at,
                unread_count,
                pause_until,
                pause_reason,
                pool_reason,
                lost_reason_code,
                lost_reason,
                legacy_unverified_won,
                has_open_task,
                has_overdue_task,
                is_paused,
                created_at,
                created_at_ts,
                updated_at
            FROM tmp_filtered_leads
            WHERE v_cursor_ts IS NULL
               OR (created_at_ts, id) < (v_cursor_ts, v_cursor_id)
            ORDER BY created_at_ts DESC, id DESC
            LIMIT v_limit
        ) paged;
    END IF;

    RETURN jsonb_build_object(
        'leads', v_rows,
        'total', v_total,
        'stats', v_stats,
        'stage_counts', v_stage_counts
    );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_query_leads_unified(JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_query_leads_unified(JSONB, JSONB) TO service_role, postgres;

COMMIT;
