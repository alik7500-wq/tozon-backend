-- =============================================================================
-- Rollback Migration 052: Revert Tasks RLS and Multi-Instance Safety Hardening
-- Mode: LOCAL DEFINITION (Prepared for rollback reference if needed)
-- =============================================================================

BEGIN;

-- 1. Drop atomic lead assignment function
DROP FUNCTION IF EXISTS public.fn_assign_lead_atomic(BIGINT, BIGINT, BIGINT, TEXT, INT, BOOLEAN);

-- 2. Drop partial unique indexes for task deduplication
DROP INDEX IF EXISTS public.uq_tasks_open_deal_type;
DROP INDEX IF EXISTS public.uq_tasks_open_lead_call;
DROP INDEX IF EXISTS public.uq_tasks_idempotency_key;

-- 3. Drop tasks service_role policy
DROP POLICY IF EXISTS tasks_service_role ON public.tasks;

-- 4. Revert RLS on tasks table (restore pre-052 baseline)
ALTER TABLE public.tasks DISABLE ROW LEVEL SECURITY;

-- 5. Restore default table grants for standard CRM roles
GRANT ALL ON public.tasks TO anon, authenticated, service_role, postgres;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'tasks_id_seq' AND relkind = 'S') THEN
    EXECUTE 'GRANT ALL ON SEQUENCE public.tasks_id_seq TO anon, authenticated, service_role, postgres;';
  END IF;
END $$;

COMMIT;
