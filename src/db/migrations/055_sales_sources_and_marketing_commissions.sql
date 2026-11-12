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
    CHECK (commission_type IN ('NONE', 'PERCENT', 'FIXED_USD')),
  commission_rate_bp INTEGER NOT NULL DEFAULT 0
    CHECK (commission_rate_bp >= 0 AND commission_rate_bp <= 10000),
  commission_fixed_minor BIGINT NOT NULL DEFAULT 0
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
  contract_price_minor BIGINT NOT NULL DEFAULT 0,
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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketing_commissions_partner_status
  ON public.marketing_commissions(partner_id, status);

COMMIT;
