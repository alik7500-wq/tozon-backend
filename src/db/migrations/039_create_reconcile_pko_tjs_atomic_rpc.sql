-- Migration 039: Create atomic RPC for ADMIN manual historical PKO TJS amount reconciliation

CREATE OR REPLACE FUNCTION public.reconcile_pko_tjs_atomic(
  p_payment_id INT,
  p_amount_tjs NUMERIC,
  p_amount_usd NUMERIC,
  p_exchange_rate NUMERIC,
  p_reason TEXT,
  p_comment TEXT,
  p_user_id INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_payment RECORD;
  v_new_activity_id BIGINT;
  v_result JSONB;
BEGIN
  -- 1. Lock payment row for update
  SELECT * INTO v_payment
  FROM public.payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND: ПКО с ID % не найден', p_payment_id;
  END IF;

  -- 2. Verify payment status is ACTIVE
  IF v_payment.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'INVALID_STATUS: Нельзя восстановить сумму для неактивного или аннулированного ПКО (status: %)', v_payment.status;
  END IF;

  -- 3. Idempotency check: verify amount_tjs is currently NULL
  IF v_payment.amount_tjs IS NOT NULL AND v_payment.amount_tjs > 0 THEN
    RAISE EXCEPTION 'ALREADY_RECONCILED: Историческая сумма TJS уже восстановлена (%)', v_payment.amount_tjs;
  END IF;

  -- 4. Validate input TJS amount
  IF p_amount_tjs IS NULL OR p_amount_tjs <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT_TJS: Фактическая сумма TJS должна быть больше 0';
  END IF;

  -- 5. Validate exchange_rate if provided
  IF p_exchange_rate IS NOT NULL AND p_exchange_rate <= 0 THEN
    RAISE EXCEPTION 'INVALID_EXCHANGE_RATE: Исторический курс должен быть больше 0';
  END IF;

  -- 6. Perform allowed mutation only on amount_tjs, amount_usd, and exchange_rate
  UPDATE public.payments
  SET
    amount_tjs = p_amount_tjs,
    amount_usd = COALESCE(p_amount_usd, (v_payment.amount_minor / 100.0)),
    exchange_rate = p_exchange_rate
  WHERE id = p_payment_id;

  -- 7. Record audit trail in activity_log
  INSERT INTO public.activity_log (
    entity_type,
    entity_id,
    action,
    user_id,
    created_at,
    details
  ) VALUES (
    'PAYMENT',
    p_payment_id::text,
    'HISTORICAL_PKO_TJS_RECONCILED',
    p_user_id,
    NOW(),
    jsonb_build_object(
      'payment_id', p_payment_id,
      'reference', v_payment.reference,
      'previous_amount_tjs', v_payment.amount_tjs,
      'new_amount_tjs', p_amount_tjs,
      'existing_amount_minor', v_payment.amount_minor,
      'currency', v_payment.currency,
      'entered_exchange_rate', p_exchange_rate,
      'calculated_usd_equivalent', COALESCE(p_amount_usd, (v_payment.amount_minor / 100.0)),
      'existing_usd_credit', (v_payment.amount_minor / 100.0),
      'difference_usd', CASE WHEN p_amount_usd IS NOT NULL THEN (p_amount_usd - (v_payment.amount_minor / 100.0)) ELSE 0 END,
      'reconciliation_reason', p_reason,
      'reconciliation_comment', p_comment,
      'performed_by_user_id', p_user_id,
      'performed_at', NOW()
    )
  )
  RETURNING id INTO v_new_activity_id;

  -- 8. Return updated payment record
  SELECT jsonb_build_object(
    'success', true,
    'payment_id', p_payment_id,
    'amount_tjs', p_amount_tjs,
    'amount_usd', COALESCE(p_amount_usd, (v_payment.amount_minor / 100.0)),
    'exchange_rate', p_exchange_rate,
    'activity_log_id', v_new_activity_id
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- Security hardening: revoke public execution and grant service_role & postgres only
REVOKE EXECUTE ON FUNCTION public.reconcile_pko_tjs_atomic(INT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reconcile_pko_tjs_atomic(INT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.reconcile_pko_tjs_atomic(INT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, INT) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.reconcile_pko_tjs_atomic(INT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_pko_tjs_atomic(INT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, INT) TO postgres;
