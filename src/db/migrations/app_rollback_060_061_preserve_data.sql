-- =============================================================================
-- Safe Application Rollback for 060/061 (DATA-PRESERVING & DEAL-AUTHORITATIVE)
-- Description:
--   Restores compatibility for the previous application version WITHOUT dropping
--   any tables, columns, contacts, communications, outbox events, or leads.
--   Authoritative sale status comes strictly from public.deals:
--   - At least one SIGNED deal -> leads.status = 'WON' (even if another deal is CANCELLED)
--   - Legacy WON without any SIGNED deal -> NEVER promoted/kept as confirmed sale;
--     aligned to 'NEGOTIATION' (unless LOST) while preserving history and deals.
--   - RESERVED / DRAFT deals (without SIGNED) -> 'NEGOTIATION' (never WON).
--   Idempotent: safe to run multiple times.
-- =============================================================================

BEGIN;

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

-- Re-assert strict EXECUTE privileges on all fn_assign_lead_atomic overloads
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
