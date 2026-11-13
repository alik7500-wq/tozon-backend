-- =============================================================================
-- Rollback: rollback_056_unit_status_history_and_reserved_at.sql
-- Purpose: Safely revert 056_unit_status_history_and_reserved_at.sql
-- =============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_log_unit_status_change ON public.units;
DROP FUNCTION IF EXISTS public.fn_log_unit_status_change();

ALTER TABLE public.deals
  DROP COLUMN IF EXISTS reserved_at;

DROP TABLE IF EXISTS public.unit_status_history;
DROP FUNCTION IF EXISTS public.fn_safe_parse_timestamptz(TEXT);

COMMIT;

