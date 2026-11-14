-- =============================================================================
-- Migration: 058_marketing_commission_calculation_only.sql
-- Purpose:
--   Minimal, calculation-only migration for marketer commissions (0/2/3/4%).
--   - Creates/updates read-only function `public.compute_marketing_commission_from_db(BIGINT)`
--     accounting for confirmed cash payments, credited barter, and refunds.
--   - Does NOT create `marketing_commission_operations`, `marketing_commission_rko_history`,
--     payout/refund/reconcile RPCs, or `expenses` triggers.
--   - Keeps automatic payouts, RKO linking, and financial reconciliations DISABLED.
--   - Security: SECURITY DEFINER, fixed search_path, EXECUTE granted ONLY to
--     `service_role` and `postgres`.
-- NOTE: Do NOT run on production without explicit owner approval.
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.compute_marketing_commission_from_db(BIGINT);

CREATE OR REPLACE FUNCTION public.compute_marketing_commission_from_db(
  p_deal_id BIGINT
)
RETURNS TABLE (
  contract_price_minor BIGINT,
  settled_minor BIGINT,
  rate_bp INTEGER,
  calculated_minor BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deal RECORD;
  v_cash_minor BIGINT := 0;
  v_barter_minor BIGINT := 0;
  v_barter_rows BIGINT := 0;
  v_contract_price BIGINT := 0;
  v_settled BIGINT := 0;
  v_rate INTEGER := 0;
  v_calc BIGINT := 0;
BEGIN
  SELECT id, final_price_minor, barter_amount_minor, refund_amount_minor
  INTO v_deal
  FROM public.deals
  WHERE id = p_deal_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DEAL_NOT_FOUND: Сделка % не найдена', p_deal_id;
  END IF;

  v_contract_price := GREATEST(0, COALESCE(v_deal.final_price_minor, 0));

  SELECT
    COALESCE(SUM(CASE WHEN UPPER(COALESCE(settlement_method, method, '')) <> 'BARTER' THEN GREATEST(0, COALESCE(amount_minor, 0)) ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN UPPER(COALESCE(settlement_method, method, '')) = 'BARTER' THEN GREATEST(0, COALESCE(amount_minor, 0)) ELSE 0 END), 0),
    COUNT(*) FILTER (WHERE UPPER(COALESCE(settlement_method, method, '')) = 'BARTER')
  INTO v_cash_minor, v_barter_minor, v_barter_rows
  FROM public.payments
  WHERE deal_id = p_deal_id
    AND voided_at IS NULL
    AND UPPER(COALESCE(status, 'ACTIVE')) NOT IN ('VOIDED', 'CANCELLED', 'REVERSED');

  IF COALESCE(v_deal.barter_amount_minor, 0) > 0 AND v_barter_rows = 0 THEN
    v_barter_minor := v_barter_minor + v_deal.barter_amount_minor;
  END IF;

  v_settled := GREATEST(0, v_cash_minor + v_barter_minor - GREATEST(0, COALESCE(v_deal.refund_amount_minor, 0)));

  IF v_contract_price > 0 AND v_settled > 0 THEN
    IF (v_settled::NUMERIC * 100) < (v_contract_price::NUMERIC * 5) THEN
      v_rate := 0;
    ELSIF (v_settled::NUMERIC * 100) < (v_contract_price::NUMERIC * 10) THEN
      v_rate := 200;
    ELSIF (v_settled::NUMERIC * 100) <= (v_contract_price::NUMERIC * 15) THEN
      v_rate := 300;
    ELSE
      v_rate := 400;
    END IF;
  ELSE
    v_rate := 0;
  END IF;

  v_calc := CASE
    WHEN v_rate > 0 THEN ROUND((v_contract_price::NUMERIC * v_rate) / 10000)::BIGINT
    ELSE 0
  END;

  RETURN QUERY SELECT v_contract_price, v_settled, v_rate, v_calc;
END;
$$;

REVOKE ALL ON FUNCTION public.compute_marketing_commission_from_db(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_marketing_commission_from_db(BIGINT) TO service_role, postgres;

COMMIT;
