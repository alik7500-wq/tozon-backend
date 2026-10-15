-- Migration 046: Sales Representative flag and Warehouse Manager role support
-- Date: 2026-10-15
-- Objective:
-- 1. Add is_sales_rep column to users table with default false.
-- 2. Add index for fast querying of active sales department representatives.
-- 3. Prepare role change for User 6 (zavsklad@tozon.crm) from SALES_MANAGER to WAREHOUSE_MANAGER.
-- 4. Exclude ADMIN, DIRECTOR, FINANCE_MANAGER from being automatically counted as sales reps.

-- 1. Add is_sales_rep column if not exists
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS is_sales_rep BOOLEAN DEFAULT false;

COMMENT ON COLUMN public.users.is_sales_rep IS 'Flag identifying active sales department representatives eligible for sales plans, lead routing, and manager rankings';

-- 2. Create partial index for active sales representatives
CREATE INDEX IF NOT EXISTS idx_users_is_sales_rep ON public.users(is_sales_rep) WHERE is_sales_rep = true;

-- 3. Backfill non-sales staff explicitly to is_sales_rep = false
UPDATE public.users
SET is_sales_rep = false
WHERE role IN ('ADMIN', 'DIRECTOR', 'FINANCE_MANAGER');

-- 4. Update check constraint on users.role to include 'WAREHOUSE_MANAGER'
DO $$ 
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'users_role_check' 
          AND conrelid = 'public.users'::regclass
    ) THEN
        ALTER TABLE public.users DROP CONSTRAINT users_role_check;
    END IF;
    ALTER TABLE public.users ADD CONSTRAINT users_role_check 
    CHECK (role = ANY (ARRAY['ADMIN'::text, 'DIRECTOR'::text, 'SALES_MANAGER'::text, 'FINANCE_MANAGER'::text, 'MANAGER'::text, 'WAREHOUSE_MANAGER'::text]));
END $$;

-- 5. Prepared role update for User ID 6 (Усмонов Саидкодир)
-- Preserves all existing construction and expense permissions exactly with access.v2 write support:
-- ["access.v2", "construction.stock", "construction.stock.write", "construction.advance", "construction.advance.write", "construction.settlements", "finance.expenses", "finance.expenses.write"]
UPDATE public.users
SET role = 'WAREHOUSE_MANAGER',
    is_sales_rep = false,
    permissions = '["access.v2", "construction.stock", "construction.stock.write", "construction.advance", "construction.advance.write", "construction.settlements", "finance.expenses", "finance.expenses.write"]'::jsonb
WHERE id = 6 AND email = 'zavsklad@tozon.crm';
