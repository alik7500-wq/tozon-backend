-- =============================================================================
-- Safe Application Rollback for 060/061 (DATA-PRESERVING)
-- Description:
--   Restores compatibility for the previous application version WITHOUT dropping
--   any tables, columns, contacts, communications, outbox events, or leads.
--   Use this for staging/production application rollback.
--   NEVER run rollback_060_crm_sales_completion_foundation.sql on preserved data.
-- =============================================================================

BEGIN;

-- 1. Ensure legacy `status` column stays aligned with canonical `stage`
--    so the previous app version renders all leads created after 060 cleanly.
UPDATE public.leads
SET status = CASE
    WHEN stage IN ('MEETING_SCHEDULED', 'SHOWING_DONE', 'RESERVED', 'CONTRACT_PREP') THEN 'NEGOTIATION'
    WHEN stage = 'SIGNED' THEN 'WON'
    WHEN stage = 'LOST' THEN 'LOST'
    WHEN stage = 'IN_PROGRESS' THEN 'IN_PROGRESS'
    ELSE 'NEW'
END
WHERE stage IS NOT NULL
  AND status IS DISTINCT FROM CASE
    WHEN stage IN ('MEETING_SCHEDULED', 'SHOWING_DONE', 'RESERVED', 'CONTRACT_PREP') THEN 'NEGOTIATION'
    WHEN stage = 'SIGNED' THEN 'WON'
    WHEN stage = 'LOST' THEN 'LOST'
    WHEN stage = 'IN_PROGRESS' THEN 'IN_PROGRESS'
    ELSE 'NEW'
  END;

-- 2. Re-assert strict EXECUTE privileges on all fn_assign_lead_atomic overloads
--    while keeping the 6-argument signature functional for the previous app version.
DO $$
DECLARE
    fn_sig TEXT;
BEGIN
    FOR fn_sig IN
        SELECT p.oid::regprocedure::text
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'fn_assign_lead_atomic'
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated;', fn_sig);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role, postgres;', fn_sig);
    END LOOP;
END $$;

COMMIT;
