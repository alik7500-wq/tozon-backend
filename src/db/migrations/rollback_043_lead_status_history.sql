-- Rollback 043: Lead Status History
BEGIN;

DROP TABLE IF EXISTS public.lead_status_history CASCADE;

COMMIT;
