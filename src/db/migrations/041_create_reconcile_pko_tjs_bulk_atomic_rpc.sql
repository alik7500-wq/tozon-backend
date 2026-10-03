-- Migration: 041_create_reconcile_pko_tjs_bulk_atomic_rpc.sql
-- Description: Create atomic bulk historical PKO TJS reconciliation RPC function

BEGIN;

CREATE OR REPLACE FUNCTION public.reconcile_pko_tjs_bulk_atomic(
  p_items JSONB,
  p_user_id INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_item JSONB;
  v_payment RECORD;
  v_payment_id INT;
  v_amount_tjs NUMERIC;
  v_exchange_rate NUMERIC;
  v_amount_usd NUMERIC;
  v_reason TEXT;
  v_comment TEXT;
  v_existing_usd_credit NUMERIC;
  v_calculated_usd NUMERIC;
  v_diff_usd NUMERIC;
  v_batch_id TEXT;
  v_reconciled_count INT := 0;
  v_new_audit_id BIGINT;
BEGIN
  -- Generate unique batch ID for audit tracing
  v_batch_id := 'batch_' || EXTRACT(EPOCH FROM NOW())::BIGINT || '_' || floor(random() * 100000)::text;

  -- Validate input array
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'EMPTY_BATCH: Список ПКО для массовой сверки пуст.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Iterate through each item in the batch
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_payment_id := (v_item->>'payment_id')::INT;
    v_amount_tjs := (v_item->>'amount_tjs')::NUMERIC;
    
    IF (v_item->>'exchange_rate') IS NOT NULL AND (v_item->>'exchange_rate')::NUMERIC > 0 THEN
      v_exchange_rate := (v_item->>'exchange_rate')::NUMERIC;
    ELSE
      v_exchange_rate := NULL;
    END IF;

    v_reason := TRIM(COALESCE(v_item->>'reason', 'Бумажный ПКО'));
    v_comment := TRIM(COALESCE(v_item->>'comment', 'Массовое восстановление TJS'));

    -- 1. Lock payment row for update
    SELECT * INTO v_payment
    FROM public.payments
    WHERE id = v_payment_id
    FOR UPDATE;

    -- 2. Validate existence
    IF v_payment.id IS NULL THEN
      RAISE EXCEPTION 'PAYMENT_NOT_FOUND: ПКО #% не найден в базе данных.', v_payment_id
        USING ERRCODE = 'P0002';
    END IF;

    -- 3. Validate status
    IF v_payment.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'INVALID_PAYMENT_STATUS: ПКО #% не активен (status: %). Отмена всей пачки.', v_payment_id, v_payment.status
        USING ERRCODE = 'P0001';
    END IF;

    -- 4. Idempotency check: amount_tjs must be NULL
    IF v_payment.amount_tjs IS NOT NULL THEN
      RAISE EXCEPTION 'HISTORICAL_PKO_ALREADY_RECONCILED: ПКО #% уже имеет восстановленную сумму TJS. Отмена всей пачки.', v_payment_id
        USING ERRCODE = 'P0003';
    END IF;

    -- 5. Validate amount_tjs > 0
    IF v_amount_tjs IS NULL OR v_amount_tjs <= 0 THEN
      RAISE EXCEPTION 'INVALID_AMOUNT_TJS: ПКО #% имеет некорректную сумму TJS (%).', v_payment_id, v_amount_tjs
        USING ERRCODE = 'P0001';
    END IF;

    -- 6. Calculate USD financial equivalents
    v_existing_usd_credit := ROUND((COALESCE(v_payment.amount_minor, 0)::NUMERIC / 100.0), 2);

    IF v_exchange_rate IS NOT NULL AND v_exchange_rate > 0 THEN
      v_calculated_usd := ROUND((v_amount_tjs / v_exchange_rate), 2);
    ELSE
      v_calculated_usd := v_existing_usd_credit;
    END IF;

    v_diff_usd := ROUND((v_calculated_usd - v_existing_usd_credit), 2);

    -- 7. Snapshot update ON PAYMENTS (Immutable: amount_minor, currency, status, deal_id, cash_desk_id)
    UPDATE public.payments
    SET
      amount_tjs = v_amount_tjs,
      exchange_rate = v_exchange_rate,
      amount_usd = v_calculated_usd
    WHERE id = v_payment_id;

    -- 8. Record audit trail in canonical deal_audit_logs table
    INSERT INTO public.deal_audit_logs (
      deal_id,
      user_id,
      action,
      changes_json,
      created_at
    ) VALUES (
      v_payment.deal_id,
      p_user_id,
      'HISTORICAL_PKO_TJS_RECONCILED',
      jsonb_build_object(
        'reconciliation_batch_id', v_batch_id,
        'payment_id', v_payment_id,
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
        'performed_by_user_id', p_user_id,
        'performed_at', NOW()
      ),
      NOW()
    )
    RETURNING id INTO v_new_audit_id;

    v_reconciled_count := v_reconciled_count + 1;
  END LOOP;

  -- Return structured batch result
  RETURN jsonb_build_object(
    'success', true,
    'reconciled_count', v_reconciled_count,
    'batch_id', v_batch_id
  );
END;
$$;

-- Security Hardening
REVOKE EXECUTE ON FUNCTION public.reconcile_pko_tjs_bulk_atomic(JSONB, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reconcile_pko_tjs_bulk_atomic(JSONB, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.reconcile_pko_tjs_bulk_atomic(JSONB, INT) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.reconcile_pko_tjs_bulk_atomic(JSONB, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_pko_tjs_bulk_atomic(JSONB, INT) TO postgres;

COMMIT;
