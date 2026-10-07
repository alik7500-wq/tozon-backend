-- 042_fix_atomic_cash_transfer_tjs_snapshot.sql
-- Fix create_atomic_cash_transfer RPC to preserve amount_tjs and exchange_rate when provided for USD transfers

CREATE OR REPLACE FUNCTION create_atomic_cash_transfer(
  p_source_cash_desk_id UUID,
  p_destination_cash_desk_id UUID,
  p_operation_type VARCHAR,
  p_currency VARCHAR,
  p_amount_tjs NUMERIC,
  p_exchange_rate NUMERIC,
  p_amount_usd NUMERIC,
  p_transfer_date DATE,
  p_recipient VARCHAR,
  p_description TEXT,
  p_idempotency_key VARCHAR,
  p_user_id INT
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_desk RECORD;
  v_dest_desk RECORD;
  v_final_amount_usd NUMERIC(14,2);
  v_final_amount_tjs NUMERIC(14,2);
  v_final_exchange_rate NUMERIC(12,6);
  v_amount_minor BIGINT;
  v_available_balance NUMERIC(14,2);
  v_source_income NUMERIC(14,2);
  v_source_expense NUMERIC(14,2);
  v_transfer_id UUID;
  v_expense_id INT;
  v_payment_id INT;
  v_next_rko_num INT;
  v_next_pko_num INT;
  v_rko_ref VARCHAR(64);
  v_pko_ref VARCHAR(64);
  v_existing_transfer RECORD;
BEGIN
  -- 1. Check idempotency
  IF p_idempotency_key IS NOT NULL AND p_idempotency_key <> '' THEN
    SELECT * INTO v_existing_transfer FROM cash_transfers WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'idempotent', true,
        'transfer_id', v_existing_transfer.id,
        'source_expense_id', v_existing_transfer.source_expense_id,
        'destination_payment_id', v_existing_transfer.destination_payment_id,
        'amount_usd', v_existing_transfer.amount_usd,
        'amount_tjs', v_existing_transfer.amount_tjs,
        'exchange_rate', v_existing_transfer.exchange_rate,
        'status', v_existing_transfer.status
      );
    END IF;
  END IF;

  -- 2. Check cash desks
  IF p_source_cash_desk_id = p_destination_cash_desk_id THEN
    RAISE EXCEPTION 'SOURCE_AND_DESTINATION_MUST_BE_DIFFERENT';
  END IF;

  SELECT * INTO v_source_desk FROM dictionaries WHERE id = p_source_cash_desk_id AND type = 'CASH_DESK';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOURCE_CASH_DESK_NOT_FOUND';
  END IF;

  SELECT * INTO v_dest_desk FROM dictionaries WHERE id = p_destination_cash_desk_id AND type = 'CASH_DESK';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DESTINATION_CASH_DESK_NOT_FOUND';
  END IF;

  -- 3. Calculate and validate snapshot amounts and rates
  IF p_currency = 'TJS' THEN
    IF p_amount_tjs IS NULL OR p_amount_tjs <= 0 THEN
      RAISE EXCEPTION 'INVALID_TJS_AMOUNT';
    END IF;
    v_final_amount_tjs := ROUND(p_amount_tjs, 2);

    IF p_exchange_rate IS NOT NULL AND p_exchange_rate > 0 THEN
      v_final_exchange_rate := p_exchange_rate;
      v_final_amount_usd := ROUND(v_final_amount_tjs / v_final_exchange_rate, 2);
    ELSIF p_amount_usd IS NOT NULL AND p_amount_usd > 0 THEN
      v_final_amount_usd := ROUND(p_amount_usd, 2);
      v_final_exchange_rate := ROUND(v_final_amount_tjs / v_final_amount_usd, 6);
    ELSE
      v_final_amount_usd := NULL;
      v_final_exchange_rate := NULL;
    END IF;
  ELSE
    IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
      RAISE EXCEPTION 'INVALID_USD_AMOUNT';
    END IF;
    v_final_amount_usd := ROUND(p_amount_usd, 2);

    IF p_amount_tjs IS NOT NULL AND p_amount_tjs > 0 AND p_exchange_rate IS NOT NULL AND p_exchange_rate > 0 THEN
      v_final_amount_tjs := ROUND(p_amount_tjs, 2);
      v_final_exchange_rate := p_exchange_rate;
    ELSIF p_amount_tjs IS NOT NULL AND p_amount_tjs > 0 THEN
      v_final_amount_tjs := ROUND(p_amount_tjs, 2);
      v_final_exchange_rate := ROUND(v_final_amount_tjs / v_final_amount_usd, 6);
    ELSIF p_exchange_rate IS NOT NULL AND p_exchange_rate > 0 THEN
      v_final_exchange_rate := p_exchange_rate;
      v_final_amount_tjs := ROUND(v_final_amount_usd * v_final_exchange_rate, 2);
    ELSE
      v_final_amount_tjs := NULL;
      v_final_exchange_rate := NULL;
    END IF;
  END IF;

  v_amount_minor := (v_final_amount_usd * 100)::BIGINT;

  -- 4. Check available balance of source cash desk (in USD)
  SELECT COALESCE(SUM(amount_minor), 0) / 100.0 INTO v_source_income
  FROM payments
  WHERE (cash_desk_id = p_source_cash_desk_id OR (cash_desk_id IS NULL AND comment ILIKE '%' || v_source_desk.name || '%'))
    AND status = 'ACTIVE'
    AND currency = 'USD';

  SELECT COALESCE(SUM(amount_minor), 0) / 100.0 INTO v_source_expense
  FROM expenses
  WHERE (cash_desk_id = p_source_cash_desk_id OR (cash_desk_id IS NULL AND description ILIKE '%' || v_source_desk.name || '%'))
    AND status = 'ACTIVE'
    AND currency = 'USD';

  v_available_balance := v_source_income - v_source_expense;

  IF v_available_balance < v_final_amount_usd THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS: Available USD % is less than requested USD %', v_available_balance, v_final_amount_usd;
  END IF;

  -- 5. Generate transfer_id and references
  v_transfer_id := gen_random_uuid();
  v_next_rko_num := COALESCE((SELECT MAX(id) FROM expenses), 0) + 1;
  v_next_pko_num := COALESCE((SELECT MAX(id) FROM payments), 0) + 1;
  v_rko_ref := 'РКО-ПЕРЕМ-' || v_next_rko_num;
  v_pko_ref := 'ПКО-ПЕРЕМ-' || v_next_pko_num;

  -- 6. Insert source RKO
  INSERT INTO expenses (
    amount_minor, expense_date, category, description, created_by_user_id, created_at,
    currency, method, reference, recipient, exchange_rate, amount_usd, amount_tjs,
    cash_desk_id, transfer_id, status, operation_type
  ) VALUES (
    v_amount_minor, p_transfer_date, 'Внутренние перемещения между кассами',
    '[Касса: ' || v_source_desk.name || '] Внутреннее перемещение: ' || COALESCE(p_description, 'Перемещение средств') || ' • в кассу: ' || v_dest_desk.name,
    p_user_id, NOW(), 'USD', 'CASH', v_rko_ref, v_dest_desk.name,
    v_final_exchange_rate, v_final_amount_usd, v_final_amount_tjs,
    p_source_cash_desk_id, v_transfer_id, 'ACTIVE', COALESCE(p_operation_type, 'INTERNAL_CASH_TRANSFER')
  ) RETURNING id INTO v_expense_id;

  -- 7. Insert destination PKO
  INSERT INTO payments (
    deal_id, schedule_id, amount_minor, payment_date, method, reference, comment,
    created_by_user_id, created_at, currency, payer_name, cash_desk_id, transfer_id,
    status, operation_type, amount_tjs, amount_usd, exchange_rate
  ) VALUES (
    NULL, NULL, v_amount_minor, p_transfer_date::TEXT, 'CASH', v_pko_ref,
    '[Касса: ' || v_dest_desk.name || '] Внутреннее перемещение: ' || COALESCE(p_description, 'Поступление средств') || ' • из кассы: ' || v_source_desk.name,
    p_user_id, NOW(), 'USD', v_source_desk.name, p_destination_cash_desk_id, v_transfer_id,
    'ACTIVE', COALESCE(p_operation_type, 'INTERNAL_CASH_TRANSFER'),
    v_final_amount_tjs, v_final_amount_usd, v_final_exchange_rate
  ) RETURNING id INTO v_payment_id;

  -- 8. Insert master cash_transfers record
  INSERT INTO cash_transfers (
    id, operation_type, source_cash_desk_id, destination_cash_desk_id,
    source_expense_id, destination_payment_id, currency, amount_minor,
    amount_tjs, amount_usd, exchange_rate, recipient, description,
    status, idempotency_key, created_by, created_at
  ) VALUES (
    v_transfer_id, COALESCE(p_operation_type, 'INTERNAL_CASH_TRANSFER'),
    p_source_cash_desk_id, p_destination_cash_desk_id,
    v_expense_id, v_payment_id, p_currency, v_amount_minor,
    v_final_amount_tjs, v_final_amount_usd, v_final_exchange_rate,
    p_recipient, p_description, 'ACTIVE', p_idempotency_key, p_user_id, NOW()
  );

  -- 9. Return JSON response
  RETURN jsonb_build_object(
    'success', true,
    'transfer_id', v_transfer_id,
    'source_expense_id', v_expense_id,
    'destination_payment_id', v_payment_id,
    'source_reference', v_rko_ref,
    'destination_reference', v_pko_ref,
    'amount_usd', v_final_amount_usd,
    'amount_tjs', v_final_amount_tjs,
    'exchange_rate', v_final_exchange_rate,
    'status', 'ACTIVE'
  );
END;
$$;
