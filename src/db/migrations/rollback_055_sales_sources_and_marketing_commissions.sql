-- =============================================================================
-- Rollback: rollback_055_sales_sources_and_marketing_commissions.sql
-- Purpose: Safely revert 055_sales_sources_and_marketing_commissions.sql
--          while preserving any partners created in `public.marketing_partners`
--          back into `public.dictionaries` (`type = 'MARKETING_PARTNER'`).
-- =============================================================================

BEGIN;

-- Preserve any partners from dedicated table into public.dictionaries before dropping
DO $$
DECLARE
  r_mp RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'marketing_partners'
  ) THEN
    FOR r_mp IN SELECT * FROM public.marketing_partners LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.dictionaries
        WHERE type = 'MARKETING_PARTNER' AND (id = r_mp.id OR name = r_mp.name)
      ) THEN
        INSERT INTO public.dictionaries (type, name, code, is_active, sort_order, created_at, updated_at)
        VALUES (
          'MARKETING_PARTNER',
          r_mp.name,
          jsonb_build_object(
            'contactPerson', COALESCE(r_mp.contact_person, ''),
            'phone', COALESCE(r_mp.phone, ''),
            'commissionType', COALESCE(r_mp.commission_type, 'NONE'),
            'commissionRateBp', COALESCE(r_mp.commission_rate_bp, 0),
            'commissionFixedMinor', COALESCE(r_mp.commission_fixed_minor, 0),
            'commissionTerms', COALESCE(r_mp.commission_terms, ''),
            'cooperationStartDate', r_mp.cooperation_start_date,
            'notes', COALESCE(r_mp.notes, '')
          )::TEXT,
          r_mp.is_active,
          100,
          r_mp.created_at,
          r_mp.updated_at
        );
      END IF;
    END LOOP;
  END IF;
END $$;

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
