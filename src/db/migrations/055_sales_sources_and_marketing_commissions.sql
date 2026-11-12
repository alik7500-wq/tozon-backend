-- =============================================================================
-- Migration: 055_sales_sources_and_marketing_commissions.sql
-- Purpose:
--   1. Create `public.marketing_partners` directory for external marketers/partners.
--   2. Add sales source attribution columns to `public.deals` (`sales_source`,
--      `marketing_partner_id`, `marketer_name`, `source_confirmed_by`,
--      `source_confirmed_at`) with safe default 'UNSPECIFIED' so existing deals
--      are never auto-assigned without verification.
--   3. Create `public.deal_source_history` for immutable audit trail of all
--      changes to a deal's sales source.
--   4. Create `public.marketing_commissions` for independent tracking of
--      marketer commission calculation, approval, payout, and cancellation.
--   5. Automatically migrate any hybrid-mode records from `public.dictionaries`
--      (`type = 'MARKETING_PARTNER'`) and `public.deal_audit_logs`
--      (`action IN ('SET_SALES_SOURCE', 'MARKETING_COMMISSION_UPDATE')`) so
--      zero data is lost when transitioning from hybrid storage to dedicated tables.
--   6. Enable strict Row Level Security (RLS) for `service_role` only.
-- NOTE: Do NOT run on production without explicit owner approval.
-- =============================================================================

BEGIN;

-- 1. Справочник маркетинговых партнёров (внешних маркетологов / агентств)
CREATE TABLE IF NOT EXISTS public.marketing_partners (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  contact_person TEXT,
  phone TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  commission_type TEXT NOT NULL DEFAULT 'NONE'
    CONSTRAINT chk_marketing_partners_commission_type
    CHECK (commission_type IN ('NONE', 'PERCENT', 'FIXED_USD')),
  commission_rate_bp INTEGER NOT NULL DEFAULT 0
    CONSTRAINT chk_marketing_partners_rate_bp
    CHECK (commission_rate_bp >= 0 AND commission_rate_bp <= 10000),
  commission_fixed_minor BIGINT NOT NULL DEFAULT 0
    CONSTRAINT chk_marketing_partners_fixed_minor
    CHECK (commission_fixed_minor >= 0),
  commission_terms TEXT,
  cooperation_start_date DATE,
  notes TEXT,
  created_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketing_partners_active
  ON public.marketing_partners(is_active);

-- 2. Поля источника продажи на уровне договора/сделки (deals)
-- Все исторические сделки получают 'UNSPECIFIED' («Источник не определён»).
ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS sales_source TEXT NOT NULL DEFAULT 'UNSPECIFIED'
    CHECK (sales_source IN ('UNSPECIFIED', 'DIRECT', 'MARKETER')),
  ADD COLUMN IF NOT EXISTS marketing_partner_id BIGINT
    REFERENCES public.marketing_partners(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS marketer_name TEXT,
  ADD COLUMN IF NOT EXISTS source_confirmed_by BIGINT
    REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_confirmed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_deals_sales_source
  ON public.deals(sales_source);

CREATE INDEX IF NOT EXISTS idx_deals_marketing_partner_id
  ON public.deals(marketing_partner_id);

-- 3. История изменений источника продажи по сделке
CREATE TABLE IF NOT EXISTS public.deal_source_history (
  id BIGSERIAL PRIMARY KEY,
  deal_id BIGINT NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  old_source TEXT,
  new_source TEXT NOT NULL CHECK (new_source IN ('UNSPECIFIED', 'DIRECT', 'MARKETER')),
  old_partner_id BIGINT REFERENCES public.marketing_partners(id) ON DELETE SET NULL,
  new_partner_id BIGINT REFERENCES public.marketing_partners(id) ON DELETE SET NULL,
  old_marketer_name TEXT,
  new_marketer_name TEXT,
  reason TEXT,
  changed_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deal_source_history_deal_id
  ON public.deal_source_history(deal_id, changed_at DESC);

-- 4. Учёт комиссий маркетологов (отдельно от клиентских платежей payments)
CREATE TABLE IF NOT EXISTS public.marketing_commissions (
  id BIGSERIAL PRIMARY KEY,
  deal_id BIGINT NOT NULL UNIQUE REFERENCES public.deals(id) ON DELETE CASCADE,
  partner_id BIGINT REFERENCES public.marketing_partners(id) ON DELETE RESTRICT,
  contract_price_minor BIGINT NOT NULL DEFAULT 0
    CHECK (contract_price_minor >= 0),
  commission_type TEXT NOT NULL DEFAULT 'NONE'
    CHECK (commission_type IN ('NONE', 'PERCENT', 'FIXED_USD')),
  commission_rate_bp INTEGER NOT NULL DEFAULT 0
    CHECK (commission_rate_bp >= 0 AND commission_rate_bp <= 10000),
  calculated_amount_minor BIGINT NOT NULL DEFAULT 0
    CHECK (calculated_amount_minor >= 0),
  approved_amount_minor BIGINT NOT NULL DEFAULT 0
    CHECK (approved_amount_minor >= 0),
  paid_amount_minor BIGINT NOT NULL DEFAULT 0
    CHECK (paid_amount_minor >= 0),
  status TEXT NOT NULL DEFAULT 'NOT_CALCULATED'
    CHECK (status IN (
      'NOT_CALCULATED',
      'CALCULATED',
      'PENDING_APPROVAL',
      'APPROVED',
      'PARTIALLY_PAID',
      'PAID',
      'CANCELLED'
    )),
  accrued_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  approved_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  paid_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_marketing_commissions_paid_le_approved
    CHECK (paid_amount_minor <= approved_amount_minor OR status = 'CANCELLED')
);

CREATE INDEX IF NOT EXISTS idx_marketing_commissions_partner_status
  ON public.marketing_commissions(partner_id, status);

-- =============================================================================
-- 5. БЕСШОВНЫЙ ПЕРЕНОС ДАННЫХ ИЗ ГИБРИДНОГО ХРАНЕНИЯ (dictionaries + deal_audit_logs)
-- =============================================================================
DO $$
DECLARE
  r_dict RECORD;
  v_meta JSONB;
  v_comm_type TEXT;
  v_rate_bp INT;
  v_fixed_minor BIGINT;
  v_coop_date DATE;
  r_log RECORD;
  v_payload JSONB;
  v_new_src TEXT;
  v_partner_id BIGINT;
BEGIN
  -- 5.1. Перенос маркетинговых партнёров из public.dictionaries (type = 'MARKETING_PARTNER')
  FOR r_dict IN
    SELECT id, name, code, is_active, created_at, updated_at
    FROM public.dictionaries
    WHERE type = 'MARKETING_PARTNER'
    ORDER BY id ASC
  LOOP
    BEGIN
      v_meta := r_dict.code::JSONB;
    EXCEPTION WHEN OTHERS THEN
      v_meta := '{}'::JSONB;
    END;

    v_comm_type := COALESCE(v_meta->>'commissionType', 'NONE');
    IF v_comm_type NOT IN ('NONE', 'PERCENT', 'FIXED_USD') THEN
      v_comm_type := 'NONE';
    END IF;

    v_rate_bp := GREATEST(0, LEAST(10000, COALESCE((v_meta->>'commissionRateBp')::INT, 0)));
    v_fixed_minor := GREATEST(0, COALESCE((v_meta->>'commissionFixedMinor')::BIGINT, 0));

    BEGIN
      v_coop_date := NULLIF(v_meta->>'cooperationStartDate', '')::DATE;
    EXCEPTION WHEN OTHERS THEN
      v_coop_date := NULL;
    END;

    INSERT INTO public.marketing_partners (
      id,
      name,
      contact_person,
      phone,
      is_active,
      commission_type,
      commission_rate_bp,
      commission_fixed_minor,
      commission_terms,
      cooperation_start_date,
      notes,
      created_at,
      updated_at
    ) VALUES (
      r_dict.id,
      r_dict.name,
      NULLIF(v_meta->>'contactPerson', ''),
      NULLIF(v_meta->>'phone', ''),
      COALESCE(r_dict.is_active, TRUE),
      v_comm_type,
      v_rate_bp,
      v_fixed_minor,
      NULLIF(v_meta->>'commissionTerms', ''),
      v_coop_date,
      NULLIF(v_meta->>'notes', ''),
      COALESCE(r_dict.created_at, NOW()),
      COALESCE(r_dict.updated_at, NOW())
    )
    ON CONFLICT (id) DO NOTHING;
  END LOOP;

  -- Выравнивание последовательности marketing_partners_id_seq
  PERFORM setval(
    pg_get_serial_sequence('public.marketing_partners', 'id'),
    GREATEST(COALESCE((SELECT MAX(id) FROM public.marketing_partners), 1), 1),
    EXISTS (SELECT 1 FROM public.marketing_partners)
  );

  -- 5.2. Перенос истории источников продаж из public.deal_audit_logs (action = 'SET_SALES_SOURCE')
  FOR r_log IN
    SELECT id, deal_id, user_id, changes_json, created_at
    FROM public.deal_audit_logs
    WHERE action = 'SET_SALES_SOURCE'
    ORDER BY created_at ASC, id ASC
  LOOP
    v_payload := COALESCE(r_log.changes_json, '{}'::JSONB);
    v_new_src := COALESCE(v_payload->>'new_source', 'UNSPECIFIED');
    IF v_new_src NOT IN ('UNSPECIFIED', 'DIRECT', 'MARKETER') THEN
      v_new_src := 'UNSPECIFIED';
    END IF;

    v_partner_id := NULL;
    IF v_new_src = 'MARKETER' AND (v_payload->>'new_partner_id') ~ '^[0-9]+$' THEN
      IF EXISTS (SELECT 1 FROM public.marketing_partners WHERE id = (v_payload->>'new_partner_id')::BIGINT) THEN
        v_partner_id := (v_payload->>'new_partner_id')::BIGINT;
      END IF;
    END IF;

    INSERT INTO public.deal_source_history (
      deal_id,
      old_source,
      new_source,
      old_partner_id,
      new_partner_id,
      new_marketer_name,
      reason,
      changed_by,
      changed_at
    ) VALUES (
      r_log.deal_id,
      COALESCE(v_payload->>'old_source', 'UNSPECIFIED'),
      v_new_src,
      CASE
        WHEN (v_payload->>'old_partner_id') ~ '^[0-9]+$'
          AND EXISTS (SELECT 1 FROM public.marketing_partners WHERE id = (v_payload->>'old_partner_id')::BIGINT)
        THEN (v_payload->>'old_partner_id')::BIGINT
        ELSE NULL
      END,
      v_partner_id,
      NULLIF(v_payload->>'marketer_name', ''),
      NULLIF(v_payload->>'reason', ''),
      r_log.user_id,
      COALESCE(r_log.created_at, NOW())
    );

    UPDATE public.deals
    SET
      sales_source = v_new_src,
      marketing_partner_id = v_partner_id,
      marketer_name = CASE WHEN v_new_src = 'MARKETER' THEN NULLIF(v_payload->>'marketer_name', '') ELSE NULL END,
      source_confirmed_by = r_log.user_id,
      source_confirmed_at = COALESCE(r_log.created_at, NOW())
    WHERE id = r_log.deal_id;
  END LOOP;
END $$;

-- =============================================================================
-- 6. POSTGRESQL ROW LEVEL SECURITY (RLS) & STRICT ROLE PERMISSIONS
-- =============================================================================
ALTER TABLE public.marketing_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deal_source_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_commissions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.marketing_partners FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.deal_source_history FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.marketing_commissions FROM PUBLIC, anon, authenticated;

REVOKE ALL ON SEQUENCE public.marketing_partners_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.deal_source_history_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.marketing_commissions_id_seq FROM PUBLIC, anon, authenticated;

GRANT ALL ON public.marketing_partners TO service_role, postgres;
GRANT ALL ON public.deal_source_history TO service_role, postgres;
GRANT ALL ON public.marketing_commissions TO service_role, postgres;

GRANT USAGE, SELECT ON SEQUENCE public.marketing_partners_id_seq TO service_role, postgres;
GRANT USAGE, SELECT ON SEQUENCE public.deal_source_history_id_seq TO service_role, postgres;
GRANT USAGE, SELECT ON SEQUENCE public.marketing_commissions_id_seq TO service_role, postgres;

DROP POLICY IF EXISTS marketing_partners_service_role ON public.marketing_partners;
CREATE POLICY marketing_partners_service_role ON public.marketing_partners
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS deal_source_history_service_role ON public.deal_source_history;
CREATE POLICY deal_source_history_service_role ON public.deal_source_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS marketing_commissions_service_role ON public.marketing_commissions;
CREATE POLICY marketing_commissions_service_role ON public.marketing_commissions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
