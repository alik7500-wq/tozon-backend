-- Migration: 040_fix_reconcile_pko_tjs_atomic_audit_target.sql
-- Description: Fix reconcile_pko_tjs_atomic to use canonical deal_audit_logs table and ensure atomic transaction rollback

BEGIN;

-- 1. Ensure deal_id in deal_audit_logs is nullable to support non-deal payments
ALTER TABLE public.deal_audit_logs ALTER COLUMN deal_id DROP NOT NULL;

-- 2. Update RPC function to target canonical deal_audit_logs table
CREATE OR REPLACE FUNCTION public.reconcile_pko_tjs_atomic(
  p_payment_id INT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_payment RECORD;
  v_amount_tjs NUMERIC;
  v_exchange_rate NUMERIC;
  v_amount_usd NUMERIC;
  v_reason TEXT;
  v_comment TEXT;
  v_user_id BIGINT;
  v_existing_usd_credit NUMERIC;
  v_calculated_usd NUMERIC;
  v_diff_usd NUMERIC;
  v_new_audit_id BIGINT;
BEGIN
  -- 1. Lock payment row for update
  SELECT * INTO v_payment
  FROM public.payments
  WHERE id = p_payment_id
  FOR UPDATE;

  -- 2. Check payment existence
  IF v_payment.id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND: ПКО #% не найден.', p_payment_id
      USING ERRCODE = 'P0002';
  END IF;

  -- 3. Check payment status
  IF v_payment.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_STATUS: Восстановление доступно только для активных ПКО.'
      USING ERRCODE = 'P0001';
  END IF;

  -- 4. Idempotency check: amount_tjs must be NULL
  IF v_payment.amount_tjs IS NOT NULL THEN
    RAISE EXCEPTION 'HISTORICAL_PKO_ALREADY_RECONCILED: Историческая сумма TJS для ПКО #% уже восстановлена.', p_payment_id
      USING ERRCODE = 'P0003';
  END IF;

  -- 5. Extract and validate input values
  v_amount_tjs := (p_payload->>'amount_tjs')::NUMERIC;
  IF v_amount_tjs IS NULL OR v_amount_tjs <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT_TJS: Сумма в TJS должна быть больше 0.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_payload->>'exchange_rate' IS NOT NULL AND (p_payload->>'exchange_rate')::NUMERIC > 0 THEN
    v_exchange_rate := (p_payload->>'exchange_rate')::NUMERIC;
  ELSE
    v_exchange_rate := NULL;
  END IF;

  v_reason := TRIM(COALESCE(p_payload->>'reason', ''));
  IF v_reason = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED: Укажите основание восстановления.'
      USING ERRCODE = 'P0001';
  END IF;

  v_comment := TRIM(COALESCE(p_payload->>'comment', ''));
  IF v_comment = '' THEN
    RAISE EXCEPTION 'COMMENT_REQUIRED: Укажите комментарий / источник данных.'
      USING ERRCODE = 'P0001';
  END IF;

  v_user_id := (p_payload->>'user_id')::BIGINT;

  -- 6. Calculate USD financial equivalents for reference
  v_existing_usd_credit := ROUND((COALESCE(v_payment.amount_minor, 0)::NUMERIC / 100.0), 2);

  IF v_exchange_rate IS NOT NULL AND v_exchange_rate > 0 THEN
    v_calculated_usd := ROUND((v_amount_tjs / v_exchange_rate), 2);
  ELSE
    v_calculated_usd := v_existing_usd_credit;
  END IF;

  v_diff_usd := ROUND((v_calculated_usd - v_existing_usd_credit), 2);

  -- 7. Snapshot update ON PAYMENTS (Immutable: amount_minor, currency, status, deal_id, cash_desk_id, schedule_id)
  UPDATE public.payments
  SET
    amount_tjs = v_amount_tjs,
    exchange_rate = v_exchange_rate,
    amount_usd = v_calculated_usd
  WHERE id = p_payment_id;

  -- 8. Record audit trail in canonical deal_audit_logs table
  INSERT INTO public.deal_audit_logs (
    deal_id,
    user_id,
    action,
    changes_json,
    created_at
  ) VALUES (
    v_payment.deal_id,
    v_user_id,
    'HISTORICAL_PKO_TJS_RECONCILED',
    jsonb_build_object(
      'payment_id', p_payment_id,
      'reference', v_payment.reference,
      'previous_amount_tjs', v_payment.amount_tjs,
      'new_amount_tjs', v_amount_tjs,
      'existing_amount_minor', v_payment.amount_minor,
      'currency', v_payment.currency,
      'entered_exchange_rate', v_exchange_rate,
      'calculated_usd_equivalent', v_calculated_usd,
      'existing_usd_credit', v_existing_usd_credit,
      'difference_usd', v_diff_usd,
      'reconciliation_reason', v_reason,
      'reconciliation_comment', v_comment,
      'performed_by_user_id', v_user_id,
      'performed_at', NOW()
    ),
    NOW()
  )
  RETURNING id INTO v_new_audit_id;

  -- 9. Return structured success result
  RETURN jsonb_build_object(
    'success', true,
    'payment_id', p_payment_id,
    'amount_tjs', v_amount_tjs,
    'exchange_rate', v_exchange_rate,
    'amount_usd', v_calculated_usd,
    'amount_minor', v_payment.amount_minor,
    'audit_log_id', v_new_audit_id
  );
END;
$$;

-- Security Hardening
REVOKE EXECUTE ON FUNCTION public.reconcile_pko_tjs_atomic(INT, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reconcile_pko_tjs_atomic(INT, JSONB) FROM anon;
REVOKE EXECUTE ON FUNCTION public.reconcile_pko_tjs_atomic(INT, JSONB) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.reconcile_pko_tjs_atomic(INT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_pko_tjs_atomic(INT, JSONB) TO postgres;

COMMIT;
