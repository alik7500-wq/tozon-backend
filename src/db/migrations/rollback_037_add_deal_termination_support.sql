-- Rollback Migration: rollback_037_add_deal_termination_support.sql (V2)
-- Description: Cleanly drops created termination columns, RPC function, and restores original schedule status check constraint.

BEGIN;

-- 1. Drop atomic RPC function
DROP FUNCTION IF EXISTS public.terminate_deal_atomic(BIGINT, BIGINT, TEXT, TEXT, BIGINT, TEXT, UUID, TEXT, TEXT);

-- 2. Drop added deal_id column and index from expenses
DROP INDEX IF EXISTS public.idx_expenses_deal_id;
ALTER TABLE public.expenses DROP COLUMN IF EXISTS deal_id;

-- 3. Drop added termination tracking columns from deals
ALTER TABLE public.deals DROP COLUMN IF EXISTS paid_at_termination_minor;
ALTER TABLE public.deals DROP COLUMN IF EXISTS refund_amount_minor;
ALTER TABLE public.deals DROP COLUMN IF EXISTS retained_amount_minor;
ALTER TABLE public.deals DROP COLUMN IF EXISTS refund_expense_id;
ALTER TABLE public.deals DROP COLUMN IF EXISTS terminated_by_user_id;

-- 4. Restore original deal_payment_schedules status check constraint
ALTER TABLE public.deal_payment_schedules DROP CONSTRAINT IF EXISTS deal_payment_schedules_status_check;
ALTER TABLE public.deal_payment_schedules ADD CONSTRAINT deal_payment_schedules_status_check 
CHECK (status IN ('UPCOMING', 'DUE', 'PARTIAL', 'PAID', 'OVERDUE'));

COMMIT;
