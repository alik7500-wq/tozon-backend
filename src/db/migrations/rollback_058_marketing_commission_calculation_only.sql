-- =============================================================================
-- Rollback: rollback_058_marketing_commission_calculation_only.sql
-- Purpose: Safely revert migration 058.
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.compute_marketing_commission_from_db(BIGINT);

COMMIT;
