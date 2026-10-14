-- Migration 044: Sales Plans & Performance Control (Sales Automation V1.3)
-- Supports 4 planning scopes: DEPARTMENT, MANAGER, PROJECT, BUILDING
-- Strict USD minor cents currency model.
-- Full audit logging on create, update, and approval.
-- Strict Security: Zero public/anon/authenticated access. Internal service_role only.

BEGIN;

CREATE TABLE IF NOT EXISTS public.sales_plans (
    id BIGSERIAL PRIMARY KEY,
    period VARCHAR(7) NOT NULL, -- Format: 'YYYY-MM'
    scope_type VARCHAR(20) NOT NULL,
    manager_id BIGINT REFERENCES public.users(id) ON DELETE CASCADE,
    project_id BIGINT REFERENCES public.projects(id) ON DELETE CASCADE,
    building_id BIGINT REFERENCES public.buildings(id) ON DELETE CASCADE,
    target_deals_count INTEGER NOT NULL DEFAULT 0,
    target_volume_minor BIGINT NOT NULL DEFAULT 0,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    created_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    approved_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT chk_sales_plans_period_format CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    CONSTRAINT chk_sales_plans_scope_type CHECK (scope_type IN ('DEPARTMENT', 'MANAGER', 'PROJECT', 'BUILDING')),
    CONSTRAINT chk_sales_plans_status CHECK (status IN ('DRAFT', 'APPROVED', 'ACTIVE_LOCKED')),
    CONSTRAINT chk_sales_plans_currency CHECK (currency = 'USD'),
    CONSTRAINT chk_sales_plans_deals_count_positive CHECK (target_deals_count >= 0),
    CONSTRAINT chk_sales_plans_volume_positive CHECK (target_volume_minor >= 0),
    CONSTRAINT chk_sales_plans_scope_refs CHECK (
        (scope_type = 'DEPARTMENT' AND manager_id IS NULL AND project_id IS NULL AND building_id IS NULL) OR
        (scope_type = 'MANAGER' AND manager_id IS NOT NULL AND project_id IS NULL AND building_id IS NULL) OR
        (scope_type = 'PROJECT' AND project_id IS NOT NULL AND manager_id IS NULL AND building_id IS NULL) OR
        (scope_type = 'BUILDING' AND building_id IS NOT NULL AND manager_id IS NULL)
    )
);

-- Partial Unique Indexes for 100% duplicate protection per scope without NULL ambiguity
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_plans_department ON public.sales_plans(period) WHERE scope_type = 'DEPARTMENT';
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_plans_manager ON public.sales_plans(period, manager_id) WHERE scope_type = 'MANAGER';
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_plans_project ON public.sales_plans(period, project_id) WHERE scope_type = 'PROJECT';
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_plans_building ON public.sales_plans(period, building_id) WHERE scope_type = 'BUILDING';

-- General Lookup Indexes
CREATE INDEX IF NOT EXISTS idx_sales_plans_period ON public.sales_plans(period);
CREATE INDEX IF NOT EXISTS idx_sales_plans_scope ON public.sales_plans(scope_type);
CREATE INDEX IF NOT EXISTS idx_sales_plans_manager ON public.sales_plans(manager_id);
CREATE INDEX IF NOT EXISTS idx_sales_plans_building ON public.sales_plans(building_id);
CREATE INDEX IF NOT EXISTS idx_sales_plans_project ON public.sales_plans(project_id);

-- Audit Table for all plan alterations
CREATE TABLE IF NOT EXISTS public.sales_plan_audit_logs (
    id BIGSERIAL PRIMARY KEY,
    sales_plan_id BIGINT NOT NULL REFERENCES public.sales_plans(id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL, -- 'CREATE', 'UPDATE', 'APPROVE', 'LOCK'
    old_values JSONB,
    new_values JSONB NOT NULL,
    reason TEXT NOT NULL,
    changed_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_plan_audit_plan ON public.sales_plan_audit_logs(sales_plan_id);
CREATE INDEX IF NOT EXISTS idx_sales_plan_audit_created ON public.sales_plan_audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_plan_audit_user ON public.sales_plan_audit_logs(changed_by_user_id);

-- PostgreSQL Row Level Security (RLS) & Strict Role Permissions
ALTER TABLE public.sales_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_plan_audit_logs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.sales_plans FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.sales_plan_audit_logs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.sales_plans_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.sales_plan_audit_logs_id_seq FROM PUBLIC, anon, authenticated;

GRANT ALL ON public.sales_plans TO service_role;
GRANT ALL ON public.sales_plan_audit_logs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.sales_plans_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.sales_plan_audit_logs_id_seq TO service_role;

DROP POLICY IF EXISTS sales_plans_service_role ON public.sales_plans;
CREATE POLICY sales_plans_service_role ON public.sales_plans
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS sales_plan_audit_logs_service_role ON public.sales_plan_audit_logs;
CREATE POLICY sales_plan_audit_logs_service_role ON public.sales_plan_audit_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
