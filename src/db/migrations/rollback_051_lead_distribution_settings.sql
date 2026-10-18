-- Rollback 051: Revert Lead Distribution Settings
-- Description: Safely disables automated lead distribution and restores fallback mode without DROP TABLE
-- Mode: LOCAL DEFINITION (Prepared for rollback plan. DO NOT APPLY TO PRODUCTION WITHOUT EXPLICIT OWNER CONSENT)

BEGIN;

-- 1. Strictly disable automated distribution
UPDATE public.lead_distribution_settings
SET enabled = FALSE,
    updated_at = NOW()
WHERE id = 1;

-- 2. Revoke permissions from external roles while preserving audit record
REVOKE ALL ON public.lead_distribution_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.lead_distribution_settings TO service_role, postgres;

-- (Optional: DROP TABLE IF EXISTS public.lead_distribution_settings CASCADE; -- only if explicitly required by owner)

COMMIT;
