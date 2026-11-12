-- =============================================================================
-- Rollback: rollback_055_sales_sources_and_marketing_commissions.sql
-- Purpose: Safely revert 055_sales_sources_and_marketing_commissions.sql
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.marketing_commissions;
DROP TABLE IF EXISTS public.deal_source_history;

ALTER TABLE public.deals
  DROP COLUMN IF EXISTS source_confirmed_at,
  DROP COLUMN IF EXISTS source_confirmed_by,
  DROP COLUMN IF EXISTS marketer_name,
  DROP COLUMN IF EXISTS marketing_partner_id,
  DROP COLUMN IF EXISTS sales_source;

DROP TABLE IF EXISTS public.marketing_partners;

COMMIT;
