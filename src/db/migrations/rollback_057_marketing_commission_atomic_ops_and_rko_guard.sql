-- =============================================================================
-- Rollback: rollback_057_marketing_commission_atomic_ops_and_rko_guard.sql
-- Purpose: Safely revert migration 057.
-- =============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_guard_void_rko_linked_commission ON public.expenses;
DROP FUNCTION IF EXISTS public.guard_void_rko_linked_commission();
DROP FUNCTION IF EXISTS public.record_marketing_commission_payout_atomic(BIGINT, BIGINT, BIGINT, BIGINT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.approve_marketing_commission_atomic(BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, BIGINT, BIGINT, TEXT, TEXT);
DROP TABLE IF EXISTS public.marketing_commission_operations;

COMMIT;

