-- =============================================================================
-- Migration 052: Harden Tasks RLS and Multi-Instance Concurrency Safety
-- Description:
--   1. Enables Row Level Security (RLS) on public.tasks, revoking anon/authenticated PostgREST access.
--   2. Adds unique indexes to prevent duplicate automated tasks across multiple backend instances.
--   3. Implements atomic PostgreSQL function fn_assign_lead_atomic with row locks (FOR UPDATE)
--      and 25-lead capacity enforcement for multi-instance clusters and service restarts.
-- Mode: LOCAL DEFINITION (Prepared for owner review. DO NOT APPLY TO PRODUCTION WITHOUT EXPLICIT OWNER CONSENT)
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. HARDEN TASKS TABLE (RLS & POSTGREST PROTECTION)
-- =============================================================================

-- Add idempotency_key column to public.tasks if it does not already exist
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);

-- Enable Row Level Security on tasks table
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

-- Revoke all permissions from untrusted public and PostgREST roles (anon, authenticated)
REVOKE ALL ON public.tasks FROM PUBLIC, anon, authenticated;

-- Revoke sequence permissions if sequence exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'tasks_id_seq' AND relkind = 'S') THEN
    EXECUTE 'REVOKE ALL ON SEQUENCE public.tasks_id_seq FROM PUBLIC, anon, authenticated;';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.tasks_id_seq TO service_role, postgres;';
  END IF;
END $$;

-- Grant full control strictly to trusted server backend role (service_role) and postgres superuser
GRANT ALL ON public.tasks TO service_role, postgres;

-- Establish service_role policy for backend CRM operations
DROP POLICY IF EXISTS tasks_service_role ON public.tasks;
CREATE POLICY tasks_service_role ON public.tasks
  FOR ALL TO service_role USING (true) WITH CHECK (true);


-- =============================================================================
-- 2. PARTIAL UNIQUE INDEXES FOR MULTI-INSTANCE TASK DEDUPLICATION
-- =============================================================================

-- Ensure uniqueness of explicit idempotency keys across all backend workers
CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_idempotency_key
  ON public.tasks(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Guarantee that at most ONE open contact call task exists per lead
CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_open_lead_call
  ON public.tasks(lead_id, type)
  WHERE status = 'OPEN' AND lead_id IS NOT NULL AND type = 'CALL';

-- Guarantee that at most ONE open task of a given type exists per deal (e.g. PAYMENT_CONTROL, RESERVATION_EXPIRY)
CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_open_deal_type
  ON public.tasks(deal_id, type)
  WHERE status = 'OPEN' AND deal_id IS NOT NULL;


-- =============================================================================
-- 3. ATOMIC LEAD ASSIGNMENT FUNCTION WITH ROW LOCKS (FOR UPDATE)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_assign_lead_atomic(
    p_lead_id BIGINT,
    p_target_user_id BIGINT,
    p_actor_user_id BIGINT,
    p_reason TEXT,
    p_max_capacity INT DEFAULT 25,
    p_is_manual BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_lead RECORD;
    v_target_user RECORD;
    v_from_user_id BIGINT;
    v_current_workload INT := 0;
    v_assigned_at TIMESTAMPTZ;
    v_assignment_type VARCHAR(50);
BEGIN
    -- 1. Exclusively lock the lead row to prevent concurrent assignment race conditions across instances
    SELECT id, status, responsible_user_id, archived_at
    INTO v_lead
    FROM public.leads
    WHERE id = p_lead_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'LEAD_NOT_FOUND',
            'message', 'Лид не найден'
        );
    END IF;

    IF v_lead.archived_at IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error_code', 'LEAD_ARCHIVED',
            'message', 'Лид архивирован'
        );
    END IF;

    v_from_user_id := v_lead.responsible_user_id;

    -- 2. Safeguard: if already assigned and automated round-robin is running, preserve existing manager!
    IF NOT p_is_manual AND v_from_user_id IS NOT NULL AND v_from_user_id > 0 THEN
        RETURN jsonb_build_object(
            'success', true,
            'status', 'PRESERVED_EXISTING',
            'lead_id', p_lead_id,
            'responsible_user_id', v_from_user_id,
            'message', 'Лид уже закреплен за ответственным менеджером; автоматическая перезапись заблокирована'
        );
    END IF;

    -- 3. If assigning to a specific representative, validate qualification and capacity
    IF p_target_user_id IS NOT NULL THEN
        -- Lock representative row to serialize workload counting across backend instances
        SELECT id, name, role, is_active, is_sales_rep
        INTO v_target_user
        FROM public.users
        WHERE id = p_target_user_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RETURN jsonb_build_object(
                'success', false,
                'error_code', 'USER_NOT_FOUND',
                'message', 'Указанный менеджер не найден'
            );
        END IF;

        IF COALESCE(v_target_user.is_active, 0) <> 1 THEN
            RETURN jsonb_build_object(
                'success', false,
                'error_code', 'USER_INACTIVE',
                'message', 'Учетная запись сотрудника деактивирована'
            );
        END IF;

        IF COALESCE(v_target_user.is_sales_rep, false) IS NOT TRUE THEN
            RETURN jsonb_build_object(
                'success', false,
                'error_code', 'USER_NOT_SALES_REP',
                'message', 'Назначение разрешено только действующему менеджеру продаж'
            );
        END IF;

        -- Count live active open leads for this representative (excluding current lead)
        SELECT COUNT(*)
        INTO v_current_workload
        FROM public.leads
        WHERE responsible_user_id = p_target_user_id
          AND status IN ('NEW', 'IN_PROGRESS', 'NEGOTIATION')
          AND archived_at IS NULL
          AND id <> p_lead_id;

        -- Capacity check: if automated and limit (25) reached, route to pool safely
        IF NOT p_is_manual AND v_current_workload >= p_max_capacity THEN
            p_target_user_id := NULL;
            v_assignment_type := 'POOL_OVERFLOW';
            v_assigned_at := NULL;
        ELSE
            v_assigned_at := NOW();
            IF p_is_manual THEN
                v_assignment_type := 'MANUAL';
            ELSE
                v_assignment_type := 'ROUND_ROBIN';
            END IF;
        END IF;
    ELSE
        -- Return / route to common unassigned pool
        v_assigned_at := NULL;
        v_assignment_type := 'POOL_RETURN';
    END IF;

    -- 4. Atomically update the lead record
    UPDATE public.leads
    SET responsible_user_id = p_target_user_id,
        assigned_at = v_assigned_at,
        reassignment_reason = p_reason,
        updated_at = NOW()::text
    WHERE id = p_lead_id;

    -- 5. Atomically record the assignment transition in audit history
    INSERT INTO public.lead_assignment_history (
        lead_id,
        from_user_id,
        to_user_id,
        assigned_by_user_id,
        assignment_type,
        reason,
        created_at
    ) VALUES (
        p_lead_id,
        v_from_user_id,
        p_target_user_id,
        p_actor_user_id,
        v_assignment_type,
        p_reason,
        NOW()
    );

    RETURN jsonb_build_object(
        'success', true,
        'status', 'ASSIGNED',
        'lead_id', p_lead_id,
        'from_user_id', v_from_user_id,
        'responsible_user_id', p_target_user_id,
        'assignment_type', v_assignment_type,
        'target_workload_after', CASE WHEN p_target_user_id IS NOT NULL THEN v_current_workload + 1 ELSE NULL END,
        'assigned_at', v_assigned_at
    );
END;
$$;

-- Secure execution permissions for fn_assign_lead_atomic
REVOKE EXECUTE ON FUNCTION public.fn_assign_lead_atomic FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_assign_lead_atomic TO service_role, postgres;

COMMIT;
