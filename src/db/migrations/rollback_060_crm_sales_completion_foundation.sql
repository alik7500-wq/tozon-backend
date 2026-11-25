-- =============================================================================
-- DESTRUCTIVE TEST-ONLY CLEANUP for Migration 060
-- WARNING: Drops tables and columns added by 060 (destroys new data).
-- NEVER use for production/staging recovery. Use app_rollback_060_061_preserve_data.sql instead.
-- Requires explicit session flag: SET LOCAL tozon.allow_destructive_test_cleanup = 'YES_TEST_ONLY';
-- =============================================================================
BEGIN;

DO $$
BEGIN
    IF current_setting('tozon.allow_destructive_test_cleanup', true) IS DISTINCT FROM 'YES_TEST_ONLY' THEN
        RAISE EXCEPTION 'DESTRUCTIVE_ROLLBACK_BLOCKED: rollback_060 is strictly for disposable test databases. Set tozon.allow_destructive_test_cleanup=YES_TEST_ONLY or use app_rollback_060_061_preserve_data.sql.';
    END IF;
END $$;

DROP TABLE IF EXISTS public.call_ai_analyses CASCADE;
DROP TABLE IF EXISTS public.crm_automation_executions CASCADE;
DROP TABLE IF EXISTS public.crm_automation_rules CASCADE;
DROP TABLE IF EXISTS public.crm_event_outbox CASCADE;
DROP TABLE IF EXISTS public.lead_stage_history CASCADE;
DROP TABLE IF EXISTS public.lead_communications CASCADE;
DROP TABLE IF EXISTS public.contacts CASCADE;

DROP INDEX IF EXISTS public.uq_lead_dist_settings_project;
ALTER TABLE public.lead_distribution_settings
    DROP COLUMN IF EXISTS project_id,
    DROP COLUMN IF EXISTS work_start_hour,
    DROP COLUMN IF EXISTS work_end_hour,
    DROP COLUMN IF EXISTS work_days_json,
    DROP COLUMN IF EXISTS sla_first_response_minutes,
    DROP COLUMN IF EXISTS allowed_user_ids,
    DROP COLUMN IF EXISTS round_robin_cursor;

ALTER TABLE public.tasks
    DROP COLUMN IF EXISTS due_at,
    DROP COLUMN IF EXISTS due_date_only,
    DROP COLUMN IF EXISTS timezone,
    DROP COLUMN IF EXISTS outcome,
    DROP COLUMN IF EXISTS outcome_notes,
    DROP COLUMN IF EXISTS completed_by,
    DROP COLUMN IF EXISTS cancel_reason,
    DROP COLUMN IF EXISTS rule_key,
    DROP COLUMN IF EXISTS event_ref;

ALTER TABLE public.leads
    DROP COLUMN IF EXISTS organization_id,
    DROP COLUMN IF EXISTS contact_id,
    DROP COLUMN IF EXISTS stage,
    DROP COLUMN IF EXISTS version,
    DROP COLUMN IF EXISTS first_human_action_at,
    DROP COLUMN IF EXISTS first_response_at,
    DROP COLUMN IF EXISTS first_contact_confirmed_at,
    DROP COLUMN IF EXISTS first_contact_origin,
    DROP COLUMN IF EXISTS last_inbound_at,
    DROP COLUMN IF EXISTS unread_count,
    DROP COLUMN IF EXISTS pause_until,
    DROP COLUMN IF EXISTS pause_reason,
    DROP COLUMN IF EXISTS pause_set_by,
    DROP COLUMN IF EXISTS pool_reason,
    DROP COLUMN IF EXISTS lost_reason_code,
    DROP COLUMN IF EXISTS lost_reason_comment,
    DROP COLUMN IF EXISTS source_code,
    DROP COLUMN IF EXISTS utm_data,
    DROP COLUMN IF EXISTS is_historical_import;

COMMIT;
