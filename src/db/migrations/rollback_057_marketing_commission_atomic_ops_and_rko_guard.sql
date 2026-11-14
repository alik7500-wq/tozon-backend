-- =============================================================================
-- Rollback: rollback_057_marketing_commission_atomic_ops_and_rko_guard.sql
-- Purpose: Safely revert migration 057.
-- =============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_guard_void_rko_linked_commission ON public.expenses;
DROP FUNCTION IF EXISTS public.guard_void_rko_linked_commission();
DROP FUNCTION IF EXISTS public.confirm_marketing_commission_payout_refund_atomic(BIGINT, BIGINT, BIGINT, BIGINT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.record_marketing_commission_payout_atomic(BIGINT, BIGINT, BIGINT, BIGINT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.approve_marketing_commission_atomic(BIGINT, BIGINT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.approve_marketing_commission_atomic(BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, BIGINT, BIGINT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.compute_marketing_commission_from_db(BIGINT);
DROP TABLE IF EXISTS public.marketing_commission_operations;

ALTER TABLE public.marketing_commissions
  DROP COLUMN IF EXISTS reconciliation_reason,
  DROP COLUMN IF EXISTS reconciliation_required;

ALTER TABLE public.marketing_commissions
  DROP CONSTRAINT IF EXISTS marketing_commissions_status_check;

ALTER TABLE public.marketing_commissions
  ADD CONSTRAINT marketing_commissions_status_check
  CHECK (status IN (
    'NOT_CALCULATED',
    'CALCULATED',
    'PENDING_APPROVAL',
    'APPROVED',
    'PARTIALLY_PAID',
    'PAID',
    'CANCELLED'
  ));

COMMIT;
