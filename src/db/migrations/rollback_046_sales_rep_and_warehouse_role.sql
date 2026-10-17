-- Rollback 046: Revert is_sales_rep and restore previous role for User 6
-- Date: 2026-10-15

-- 1. Revert User 6 role to SALES_MANAGER if needed
UPDATE public.users
SET role = 'SALES_MANAGER'
WHERE id = 6 AND email = 'zavsklad@tozon.crm';

-- 2. Restore previous check constraint if needed
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
    CHECK (role = ANY (ARRAY['ADMIN'::text, 'DIRECTOR'::text, 'SALES_MANAGER'::text, 'FINANCE_MANAGER'::text, 'MANAGER'::text]));
END $$;

-- 3. Drop index
DROP INDEX IF EXISTS idx_users_is_sales_rep;

-- 4. Drop column
ALTER TABLE public.users DROP COLUMN IF EXISTS is_sales_rep;
