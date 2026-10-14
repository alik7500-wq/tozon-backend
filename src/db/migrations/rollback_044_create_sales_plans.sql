-- Rollback Migration 044: Sales Plans & Performance Control (Sales Automation V1.3)

BEGIN;

DROP POLICY IF EXISTS sales_plan_audit_logs_service_role ON public.sales_plan_audit_logs;
DROP POLICY IF EXISTS sales_plans_service_role ON public.sales_plans;

DROP TABLE IF EXISTS public.sales_plan_audit_logs CASCADE;
DROP TABLE IF EXISTS public.sales_plans CASCADE;

COMMIT;
