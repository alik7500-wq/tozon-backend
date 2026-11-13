-- =============================================================================
-- Rollback: rollback_055_sales_sources_and_marketing_commissions.sql
-- Purpose: Safely revert 055_sales_sources_and_marketing_commissions.sql
--          while preserving:
--            1. All partners from `public.marketing_partners` -> `public.dictionaries`
--            2. All source history from `public.deal_source_history` -> `public.deal_audit_logs`
--            3. All commission states from `public.marketing_commissions` -> `public.deal_audit_logs`
--          so rolling back 055 NEVER loses any sales source or commission history.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  r_mp RECORD;
  r_src RECORD;
  r_comm RECORD;
BEGIN
  -- 1. Preserve any partners from dedicated table into public.dictionaries before dropping
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'marketing_partners'
  ) THEN
    FOR r_mp IN SELECT * FROM public.marketing_partners LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.dictionaries
        WHERE type = 'MARKETING_PARTNER'
          AND (id::TEXT = COALESCE(r_mp.legacy_dictionary_id, r_mp.id::TEXT) OR name = r_mp.name)
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

  -- 2. Preserve any source history rows from public.deal_source_history into public.deal_audit_logs
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'deal_source_history'
  ) THEN
    FOR r_src IN
      SELECT * FROM public.deal_source_history ORDER BY changed_at ASC, id ASC
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.deal_audit_logs
        WHERE deal_id = r_src.deal_id
          AND action = 'SET_SALES_SOURCE'
          AND (changes_json->>'new_source') = r_src.new_source
          AND ABS(EXTRACT(EPOCH FROM (created_at - r_src.changed_at))) < 2
      ) THEN
        INSERT INTO public.deal_audit_logs (deal_id, user_id, action, changes_json, created_at)
        VALUES (
          r_src.deal_id,
          r_src.changed_by,
          'SET_SALES_SOURCE',
          jsonb_build_object(
            'old_source', COALESCE(r_src.old_source, 'UNSPECIFIED'),
            'new_source', r_src.new_source,
            'old_partner_id', r_src.old_partner_id,
            'new_partner_id', r_src.new_partner_id,
            'marketer_name', COALESCE(r_src.new_marketer_name, ''),
            'reason', COALESCE(r_src.reason, 'Сохранено при откате миграции 055'),
            'changed_at', r_src.changed_at
          ),
          r_src.changed_at
        );
      END IF;
    END LOOP;
  END IF;

  -- 3. Preserve any commission states from public.marketing_commissions into public.deal_audit_logs
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'marketing_commissions'
  ) THEN
    FOR r_comm IN
      SELECT * FROM public.marketing_commissions ORDER BY updated_at ASC, id ASC
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.deal_audit_logs
        WHERE deal_id = r_comm.deal_id
          AND action = 'MARKETING_COMMISSION_UPDATE'
          AND (changes_json->>'status') = r_comm.status
          AND COALESCE((changes_json->>'paid_amount_minor')::BIGINT, -1) = r_comm.paid_amount_minor
          AND COALESCE((changes_json->>'approved_amount_minor')::BIGINT, -1) = r_comm.approved_amount_minor
      ) THEN
        INSERT INTO public.deal_audit_logs (deal_id, user_id, action, changes_json, created_at)
        VALUES (
          r_comm.deal_id,
          r_comm.approved_by,
          'MARKETING_COMMISSION_UPDATE',
          jsonb_build_object(
            'action_type', 'ROLLBACK_055_PRESERVE',
            'commission_type', r_comm.commission_type,
            'commission_rate_bp', r_comm.commission_rate_bp,
            'calculated_amount_minor', r_comm.calculated_amount_minor,
            'approved_amount_minor', r_comm.approved_amount_minor,
            'paid_amount_minor', r_comm.paid_amount_minor,
            'status', r_comm.status,
            'accrued_at', r_comm.accrued_at,
            'approved_at', r_comm.approved_at,
            'approved_by', r_comm.approved_by,
            'paid_at', r_comm.paid_at,
            'cancelled_at', r_comm.cancelled_at,
            'cancel_reason', r_comm.cancel_reason,
            'notes', COALESCE(r_comm.notes, 'Сохранено при откате миграции 055')
          ),
          COALESCE(r_comm.updated_at, NOW())
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
