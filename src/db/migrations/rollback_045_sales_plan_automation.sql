-- Rollback Migration 045: Sales Plan Automation & Performance Control Settings (Sales Automation V1.4)

BEGIN;

DROP INDEX IF EXISTS public.idx_user_notifications_sales_plan_events;
DROP TABLE IF EXISTS public.sales_plan_alert_settings CASCADE;

COMMIT;
