-- Migration 051: Lead Distribution Settings Table
-- Description: Structured table for persistent automated lead distribution configuration
-- Mode: LOCAL DEFINITION (Prepared for owner review and future production release. DO NOT APPLY TO PRODUCTION WITHOUT EXPLICIT OWNER CONSENT)

BEGIN;

CREATE TABLE IF NOT EXISTS public.lead_distribution_settings (
    id BIGSERIAL PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    algorithm VARCHAR(50) NOT NULL DEFAULT 'LEAST_LOADED' CHECK (algorithm IN ('LEAST_LOADED', 'ROUND_ROBIN')),
    max_open_leads_per_rep INTEGER NOT NULL DEFAULT 25 CHECK (max_open_leads_per_rep > 0),
    excluded_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    working_hours_only BOOLEAN NOT NULL DEFAULT TRUE,
    auto_reassign_on_stagnant BOOLEAN NOT NULL DEFAULT FALSE,
    updated_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed single singleton configuration row (strictly OFF by default as approved by owner)
INSERT INTO public.lead_distribution_settings (
    id,
    enabled,
    algorithm,
    max_open_leads_per_rep,
    excluded_user_ids,
    working_hours_only,
    auto_reassign_on_stagnant,
    updated_at
) VALUES (
    1,
    FALSE,
    'LEAST_LOADED',
    25,
    '[]'::jsonb,
    TRUE,
    FALSE,
    NOW()
)
ON CONFLICT (id) DO NOTHING;

-- RLS & Role Permissions
ALTER TABLE public.lead_distribution_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.lead_distribution_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.lead_distribution_settings_id_seq FROM PUBLIC, anon, authenticated;

GRANT ALL ON public.lead_distribution_settings TO service_role, postgres;
GRANT USAGE, SELECT ON SEQUENCE public.lead_distribution_settings_id_seq TO service_role, postgres;

DROP POLICY IF EXISTS lead_distribution_settings_service_role ON public.lead_distribution_settings;
CREATE POLICY lead_distribution_settings_service_role ON public.lead_distribution_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
