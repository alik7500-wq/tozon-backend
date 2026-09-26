-- Migration 034: Pure In-Database FIFO Payment Allocation & Soft Voiding for PKO Operations

CREATE OR REPLACE FUNCTION public.recalculate_deal_schedules_internal(
  p_deal_id INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_down_payment_plan INT;
  v_total_active_paid INT;
  v_down_payment_covered INT;
  v_pool INT;
  v_sched RECORD;
  v_planned INT;
  v_allocated INT;
  v_paid INT;
  v_remaining INT;
  v_new_status TEXT;
  v_today DATE := CURRENT_DATE;
BEGIN
  IF p_deal_id IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(down_payment_minor, 0) INTO v_down_payment_plan
  FROM public.deals
  WHERE id = p_deal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DEAL_NOT_FOUND: Deal ID % does not exist', p_deal_id;
  END IF;

  SELECT COALESCE(SUM(amount_minor), 0) INTO v_total_active_paid
  FROM public.payments
  WHERE deal_id = p_deal_id AND status IN ('ACTIVE', 'POSTED') AND status <> 'VOIDED';

  v_down_payment_covered := LEAST(v_total_active_paid, v_down_payment_plan);
  v_pool := GREATEST(0, v_total_active_paid - v_down_payment_covered);

  FOR v_sched IN 
    SELECT id, due_date, amount_minor, paid_amount_minor, status
    FROM public.deal_payment_schedules
    WHERE deal_id = p_deal_id
    ORDER BY due_date, id
    FOR UPDATE
  LOOP
    v_planned := COALESCE(v_sched.amount_minor, 0);
    
    IF v_pool >= v_planned THEN
      v_allocated := v_planned;
      v_pool := v_pool - v_planned;
    ELSE
      v_allocated := v_pool;
      v_pool := 0;
    END IF;

    v_paid := LEAST(v_allocated, v_planned);
    v_remaining := GREATEST(0, v_planned - v_paid);

    IF v_remaining = 0 AND v_planned > 0 THEN
      v_new_status := 'PAID';
    ELSIF v_remaining > 0 AND v_sched.due_date < v_today THEN
      v_new_status := 'OVERDUE';
    ELSIF v_paid > 0 AND v_paid < v_planned THEN
      v_new_status := 'PARTIAL';
    ELSE
      v_new_status := 'UPCOMING';
    END IF;

    UPDATE public.deal_payment_schedules
    SET paid_amount_minor = v_paid,
        status = v_new_status,
        updated_at = NOW()
    WHERE id = v_sched.id;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_income_payment_atomic(
  p_payment JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_payment_id INT;
  v_new_payment JSONB;
  v_deal_id INT;
BEGIN
  v_deal_id := (p_payment->>'deal_id')::INT;

  INSERT INTO public.payments (
    deal_id,
    schedule_id,
    amount_minor,
    currency,
    payment_date,
    method,
    settlement_method,
    reference,
    comment,
    payer_name,
    cash_desk_id,
    operation_type,
    exchange_rate,
    amount_usd,
    amount_tjs,
    created_by_user_id,
    status,
    created_at
  )
  VALUES (
    v_deal_id,
    (p_payment->>'schedule_id')::INT,
    (p_payment->>'amount_minor')::INT,
    COALESCE(p_payment->>'currency', 'USD'),
    (p_payment->>'payment_date')::DATE,
    COALESCE(p_payment->>'method', 'CASH'),
    p_payment->>'settlement_method',
    p_payment->>'reference',
    p_payment->>'comment',
    p_payment->>'payer_name',
    (p_payment->>'cash_desk_id')::UUID,
    COALESCE(p_payment->>'operation_type', 'STANDARD'),
    (p_payment->>'exchange_rate')::NUMERIC,
    (p_payment->>'amount_usd')::NUMERIC,
    (p_payment->>'amount_tjs')::NUMERIC,
    (p_payment->>'created_by_user_id')::INT,
    COALESCE(p_payment->>'status', 'ACTIVE'),
    COALESCE((p_payment->>'created_at')::TIMESTAMPTZ, NOW())
  )
  RETURNING id INTO v_payment_id;

  SELECT row_to_json(p)::JSONB INTO v_new_payment
  FROM public.payments p
  WHERE p.id = v_payment_id;

  IF v_deal_id IS NOT NULL THEN
    PERFORM public.recalculate_deal_schedules_internal(v_deal_id);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'payment', v_new_payment
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.update_income_payment_atomic(
  p_payment_id INT,
  p_payment_update JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated_payment JSONB;
  v_deal_id INT;
BEGIN
  UPDATE public.payments
  SET amount_minor = COALESCE((p_payment_update->>'amount_minor')::INT, amount_minor),
      payment_date = COALESCE((p_payment_update->>'payment_date')::DATE, payment_date),
      comment = COALESCE(p_payment_update->>'comment', comment),
      cash_desk_id = COALESCE((p_payment_update->>'cash_desk_id')::UUID, cash_desk_id)
  WHERE id = p_payment_id
  RETURNING deal_id INTO v_deal_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ROW_NOT_FOUND: Payment ID % does not exist', p_payment_id;
  END IF;

  SELECT row_to_json(p)::JSONB INTO v_updated_payment
  FROM public.payments p
  WHERE p.id = p_payment_id;

  IF v_deal_id IS NOT NULL THEN
    PERFORM public.recalculate_deal_schedules_internal(v_deal_id);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'payment', v_updated_payment
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.void_income_payment_atomic(
  p_payment_id INT,
  p_user_id INT DEFAULT NULL,
  p_void_reason TEXT DEFAULT 'Annulled via CRM'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deal_id INT;
  v_voided_payment JSONB;
BEGIN
  UPDATE public.payments
  SET status = 'VOIDED',
      voided_at = NOW(),
      voided_by = p_user_id,
      void_reason = p_void_reason
  WHERE id = p_payment_id
  RETURNING deal_id INTO v_deal_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ROW_NOT_FOUND: Payment ID % does not exist', p_payment_id;
  END IF;

  SELECT row_to_json(p)::JSONB INTO v_voided_payment
  FROM public.payments p
  WHERE p.id = p_payment_id;

  IF v_deal_id IS NOT NULL THEN
    PERFORM public.recalculate_deal_schedules_internal(v_deal_id);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'payment', v_voided_payment
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_income_payment_atomic(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_income_payment_atomic(int, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.void_income_payment_atomic(int, int, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_income_payment_atomic(jsonb) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.update_income_payment_atomic(int, jsonb) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.void_income_payment_atomic(int, int, text) TO service_role, postgres;
