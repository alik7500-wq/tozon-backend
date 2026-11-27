-- =============================================================================
-- Safe Application Rollback for Migrations 060-074 (DATA-PRESERVING)
-- Target: Allows rolling back application code to origin/main (261018ef557e54fbcfd0b31475fcb538c164201f)
--         WITHOUT dropping tables, columns, contacts, leads, tasks, outbox,
--         Instagram send operations, automation rules, AI analyses, deals, or payments.
-- Idempotent: safe to run multiple times.
-- =============================================================================

BEGIN;

-- 1. Disable background workers & automation rules so rolled-back/restarted nodes do not execute them
UPDATE public.crm_outbox_settings
SET is_enabled = FALSE,
    updated_at = NOW()
WHERE id = 1;

UPDATE public.lead_distribution_settings
SET pool_worker_enabled = FALSE,
    updated_at = NOW()
WHERE id = 1;

UPDATE public.crm_automation_rules
SET is_enabled = FALSE,
    updated_at = NOW()
WHERE is_enabled IS TRUE;

-- 2. Safely release any in-flight outbox leases without deleting queue items or idempotency keys
UPDATE public.crm_event_outbox
SET status = 'FAILED',
    lease_token = NULL,
    lease_expires_at = NULL,
    locked_by = NULL,
    last_error = COALESCE(last_error, 'APP_ROLLBACK_LEASE_RELEASED'),
    next_retry_at = NOW()
WHERE status = 'PROCESSING';

-- 3. Align leads.status with authoritative deals (SIGNED = confirmed sale; legacy WON without SIGNED != sale)
UPDATE public.leads l
SET status = CASE
    WHEN EXISTS (
        SELECT 1 FROM public.deals d
        WHERE d.lead_id = l.id AND d.status = 'SIGNED'
    ) THEN 'WON'
    WHEN l.stage = 'LOST' OR l.status = 'LOST' THEN 'LOST'
    WHEN EXISTS (
        SELECT 1 FROM public.deals d
        WHERE d.lead_id = l.id AND d.status IN ('RESERVED', 'DRAFT')
    ) THEN 'NEGOTIATION'
    WHEN l.stage IN ('MEETING_SCHEDULED', 'SHOWING_DONE', 'RESERVED', 'CONTRACT_PREP', 'NEGOTIATION', 'SIGNED')
         OR l.status = 'WON' THEN 'NEGOTIATION'
    WHEN l.stage = 'IN_PROGRESS' OR l.status = 'IN_PROGRESS' THEN 'IN_PROGRESS'
    ELSE 'NEW'
END
WHERE l.status IS DISTINCT FROM CASE
    WHEN EXISTS (
        SELECT 1 FROM public.deals d
        WHERE d.lead_id = l.id AND d.status = 'SIGNED'
    ) THEN 'WON'
    WHEN l.stage = 'LOST' OR l.status = 'LOST' THEN 'LOST'
    WHEN EXISTS (
        SELECT 1 FROM public.deals d
        WHERE d.lead_id = l.id AND d.status IN ('RESERVED', 'DRAFT')
    ) THEN 'NEGOTIATION'
    WHEN l.stage IN ('MEETING_SCHEDULED', 'SHOWING_DONE', 'RESERVED', 'CONTRACT_PREP', 'NEGOTIATION', 'SIGNED')
         OR l.status = 'WON' THEN 'NEGOTIATION'
    WHEN l.stage = 'IN_PROGRESS' OR l.status = 'IN_PROGRESS' THEN 'IN_PROGRESS'
    ELSE 'NEW'
END;

-- 4. Re-assert closed EXECUTE privileges on all 060-074 SECURITY DEFINER / sensitive functions
DO $$
DECLARE
    fn_sig TEXT;
BEGIN
    FOR fn_sig IN
        SELECT p.oid::regprocedure::text
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN (
              'fn_assign_lead_atomic',
              'fn_update_lead_stage_atomic',
              'fn_query_leads_unified',
              'fn_claim_outbox_batch',
              'fn_complete_outbox_event',
              'fn_apply_outbox_effect',
              'fn_set_user_project_access',
              'fn_outbox_diagnostics',
              'fn_outbox_preview_cutoff',
              'fn_select_and_assign_lead_atomic',
              'fn_run_lead_pool_batch'
          )
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated;', fn_sig);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role, postgres;', fn_sig);
    END LOOP;
END $$;

-- 5. Re-assert RLS & closed table privileges on all new private tables
DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'contacts', 'lead_communications', 'lead_stage_history',
        'crm_event_outbox', 'crm_automation_rules', 'crm_automation_executions',
        'call_ai_analyses', 'user_project_access', 'crm_instagram_send_operations'
    ]
    LOOP
        IF to_regclass('public.' || tbl) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', tbl);
            EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated;', tbl);
            EXECUTE format('GRANT ALL ON public.%I TO service_role, postgres;', tbl);
        END IF;
    END LOOP;
END $$;

COMMIT;
