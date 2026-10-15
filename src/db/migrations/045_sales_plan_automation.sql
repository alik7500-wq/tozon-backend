-- Migration 045: Sales Plan Automation & Performance Control Settings (Sales Automation V1.4)
-- Configurable thresholds for:
-- 1. SALES_PLAN_BEHIND_SCHEDULE
-- 2. SALES_PLAN_AT_RISK
-- 3. SALES_PLAN_ACHIEVED
-- 4. SALES_PLAN_WEEKLY_DIGEST
-- Strict Security: Zero public/anon/authenticated access. Internal service_role only.

BEGIN;

CREATE TABLE IF NOT EXISTS public.sales_plan_alert_settings (
    id SMALLINT PRIMARY KEY DEFAULT 1,
    behind_schedule_threshold_pp NUMERIC(4, 1) NOT NULL DEFAULT 15.0,
    at_risk_forecast_threshold_pct NUMERIC(4, 1) NOT NULL DEFAULT 80.0,
    min_elapsed_working_days SMALLINT NOT NULL DEFAULT 3,
    notify_achieved_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    weekly_digest_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    weekly_digest_day_of_week SMALLINT NOT NULL DEFAULT 1, -- 1 = Monday, 6 = Saturday
    weekly_digest_hour SMALLINT NOT NULL DEFAULT 9,        -- 09:00 Asia/Dushanbe
    updated_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT chk_single_settings_row CHECK (id = 1),
    CONSTRAINT chk_behind_schedule_threshold CHECK (behind_schedule_threshold_pp >= 1.0 AND behind_schedule_threshold_pp <= 90.0),
    CONSTRAINT chk_at_risk_threshold CHECK (at_risk_forecast_threshold_pct >= 10.0 AND at_risk_forecast_threshold_pct <= 99.0),
    CONSTRAINT chk_min_working_days CHECK (min_elapsed_working_days >= 0 AND min_elapsed_working_days <= 15),
    CONSTRAINT chk_weekly_digest_dow CHECK (weekly_digest_day_of_week >= 1 AND weekly_digest_day_of_week <= 7),
    CONSTRAINT chk_weekly_digest_hour CHECK (weekly_digest_hour >= 0 AND weekly_digest_hour <= 23)
);

-- Seed default initial configuration row (id = 1)
INSERT INTO public.sales_plan_alert_settings (
    id,
    behind_schedule_threshold_pp,
    at_risk_forecast_threshold_pct,
    min_elapsed_working_days,
    notify_achieved_enabled,
    weekly_digest_enabled,
    weekly_digest_day_of_week,
    weekly_digest_hour
)
VALUES (
    1,
    15.0,
    80.0,
    3,
    TRUE,
    TRUE,
    1,
    9
)
ON CONFLICT (id) DO NOTHING;

-- Index for fast lookup of sales plan notification events in user_notifications
CREATE INDEX IF NOT EXISTS idx_user_notifications_sales_plan_events 
ON public.user_notifications(event_type, created_at DESC);

-- PostgreSQL Row Level Security (RLS) & Strict Role Permissions
ALTER TABLE public.sales_plan_alert_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.sales_plan_alert_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sales_plan_alert_settings TO service_role;

DROP POLICY IF EXISTS sales_plan_alert_settings_service_role ON public.sales_plan_alert_settings;
CREATE POLICY sales_plan_alert_settings_service_role ON public.sales_plan_alert_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
