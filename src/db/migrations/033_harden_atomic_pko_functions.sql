-- Migration 033: Harden Atomic PKO Functions with Strict Deal Linkage Validation and Privilege Revocation
-- Security: REVOKE EXECUTE FROM PUBLIC, anon, authenticated. GRANT ONLY TO service_role, postgres.

-- 1. Create Atomic Payment Function with Deal Linkage Guard
CREATE OR REPLACE FUNCTION public.create_income_payment_atomic(
  p_payment JSONB,
  p_schedules JSONB DEFAULT '[]'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_payment_id INT;
  v_new_payment JSONB;
  v_item JSONB;
  v_id INT;
  v_paid INT;
  v_status TEXT;
  v_payment_deal_id INT;
  v_schedule_deal_id INT;
BEGIN
  v_payment_deal_id := (p_payment->>'deal_id')::INT;

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
    created_at
  )
  VALUES (
    v_payment_deal_id,
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
    COALESCE((p_payment->>'created_at')::TIMESTAMPTZ, NOW())
  )
  RETURNING id INTO v_payment_id;

  SELECT row_to_json(p)::JSONB INTO v_new_payment
  FROM public.payments p
  WHERE p.id = v_payment_id;

  IF jsonb_typeof(p_schedules) = 'array' AND jsonb_array_length(p_schedules) > 0 THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_schedules)
    LOOP
      v_id := (v_item->>'id')::INT;
      v_paid := (v_item->>'paid_amount_minor')::INT;
      v_status := v_item->>'status';

      IF v_status NOT IN ('PAID', 'OVERDUE', 'UPCOMING', 'PARTIAL') THEN
        RAISE EXCEPTION 'INVARIANT_VIOLATION: Invalid status % for schedule ID %', v_status, v_id;
      END IF;

      SELECT deal_id INTO v_schedule_deal_id
      FROM public.deal_payment_schedules
      WHERE id = v_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'ROW_NOT_FOUND: Schedule ID % does not exist', v_id;
      END IF;

      IF v_payment_deal_id IS NOT NULL AND v_schedule_deal_id <> v_payment_deal_id THEN
        RAISE EXCEPTION 'SECURITY_VIOLATION: Schedule ID % belongs to deal %, not payment deal %', v_id, v_schedule_deal_id, v_payment_deal_id;
      END IF;

      UPDATE public.deal_payment_schedules
      SET paid_amount_minor = v_paid,
          status = v_status,
          updated_at = NOW()
      WHERE id = v_id;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'payment', v_new_payment
  );
END;
$$;

-- 2. Update Atomic Payment Function with Deal Linkage Guard
CREATE OR REPLACE FUNCTION public.update_income_payment_atomic(
  p_payment_id INT,
  p_payment_update JSONB,
  p_schedules JSONB DEFAULT '[]'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated_payment JSONB;
  v_item JSONB;
  v_id INT;
  v_paid INT;
  v_status TEXT;
  v_payment_deal_id INT;
  v_schedule_deal_id INT;
BEGIN
  UPDATE public.payments
  SET amount_minor = COALESCE((p_payment_update->>'amount_minor')::INT, amount_minor),
      payment_date = COALESCE((p_payment_update->>'payment_date')::DATE, payment_date),
      comment = COALESCE(p_payment_update->>'comment', comment),
      cash_desk_id = COALESCE((p_payment_update->>'cash_desk_id')::UUID, cash_desk_id)
  WHERE id = p_payment_id
  RETURNING deal_id INTO v_payment_deal_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ROW_NOT_FOUND: Payment ID % does not exist', p_payment_id;
  END IF;

  SELECT row_to_json(p)::JSONB INTO v_updated_payment
  FROM public.payments p
  WHERE p.id = p_payment_id;

  IF jsonb_typeof(p_schedules) = 'array' AND jsonb_array_length(p_schedules) > 0 THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_schedules)
    LOOP
      v_id := (v_item->>'id')::INT;
      v_paid := (v_item->>'paid_amount_minor')::INT;
      v_status := v_item->>'status';

      IF v_status NOT IN ('PAID', 'OVERDUE', 'UPCOMING', 'PARTIAL') THEN
        RAISE EXCEPTION 'INVARIANT_VIOLATION: Invalid status % for schedule ID %', v_status, v_id;
      END IF;

      SELECT deal_id INTO v_schedule_deal_id
      FROM public.deal_payment_schedules
      WHERE id = v_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'ROW_NOT_FOUND: Schedule ID % does not exist', v_id;
      END IF;

      IF v_payment_deal_id IS NOT NULL AND v_schedule_deal_id <> v_payment_deal_id THEN
        RAISE EXCEPTION 'SECURITY_VIOLATION: Schedule ID % belongs to deal %, not payment deal %', v_id, v_schedule_deal_id, v_payment_deal_id;
      END IF;

      UPDATE public.deal_payment_schedules
      SET paid_amount_minor = v_paid,
          status = v_status,
          updated_at = NOW()
      WHERE id = v_id;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'payment', v_updated_payment
  );
END;
$$;

-- 3. Delete Atomic Payment Function with Deal Linkage Guard
CREATE OR REPLACE FUNCTION public.delete_income_payment_atomic(
  p_payment_id INT,
  p_schedules JSONB DEFAULT '[]'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item JSONB;
  v_id INT;
  v_paid INT;
  v_status TEXT;
  v_payment_deal_id INT;
  v_schedule_deal_id INT;
BEGIN
  DELETE FROM public.payments WHERE id = p_payment_id RETURNING deal_id INTO v_payment_deal_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ROW_NOT_FOUND: Payment ID % does not exist', p_payment_id;
  END IF;

  IF jsonb_typeof(p_schedules) = 'array' AND jsonb_array_length(p_schedules) > 0 THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_schedules)
    LOOP
      v_id := (v_item->>'id')::INT;
      v_paid := (v_item->>'paid_amount_minor')::INT;
      v_status := v_item->>'status';

      IF v_status NOT IN ('PAID', 'OVERDUE', 'UPCOMING', 'PARTIAL') THEN
        RAISE EXCEPTION 'INVARIANT_VIOLATION: Invalid status % for schedule ID %', v_status, v_id;
      END IF;

      SELECT deal_id INTO v_schedule_deal_id
      FROM public.deal_payment_schedules
      WHERE id = v_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'ROW_NOT_FOUND: Schedule ID % does not exist', v_id;
      END IF;

      IF v_payment_deal_id IS NOT NULL AND v_schedule_deal_id <> v_payment_deal_id THEN
        RAISE EXCEPTION 'SECURITY_VIOLATION: Schedule ID % belongs to deal %, not payment deal %', v_id, v_schedule_deal_id, v_payment_deal_id;
      END IF;

      UPDATE public.deal_payment_schedules
      SET paid_amount_minor = v_paid,
          status = v_status,
          updated_at = NOW()
      WHERE id = v_id;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'deleted_id', p_payment_id
  );
END;
$$;

-- Strict Role Permissions
REVOKE EXECUTE ON FUNCTION public.create_income_payment_atomic(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_income_payment_atomic(int, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_income_payment_atomic(int, jsonb) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_income_payment_atomic(jsonb, jsonb) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.update_income_payment_atomic(int, jsonb, jsonb) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.delete_income_payment_atomic(int, jsonb) TO service_role, postgres;
