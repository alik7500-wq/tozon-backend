-- Migration 030: Create Atomic PL/pgSQL RPC Function for Safe Deal Schedule Recalculation
-- Security: SET search_path = public, pg_temp; REVOKE FROM PUBLIC/anon/authenticated; GRANT TO service_role, postgres;

CREATE OR REPLACE FUNCTION recalculate_deal_schedules_atomic(
  p_updates JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item JSONB;
  v_id INT;
  v_new_paid INT;
  v_new_status TEXT;
  v_expected_paid INT;
  v_expected_status TEXT;
  
  v_current_deal_id INT;
  v_current_planned INT;
  v_current_paid INT;
  v_current_status TEXT;
  v_current_updated_at TIMESTAMPTZ;
  
  v_count INT := 0;
  v_allowed_deal_ids INT[] := ARRAY[11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 36, 37, 38, 39];
BEGIN
  -- Validate input payload is a JSON array
  IF jsonb_typeof(p_updates) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_PAYLOAD: p_updates must be a JSON array';
  END IF;

  -- Process each schedule update atomically inside transaction
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_updates)
  LOOP
    v_id := (v_item->>'id')::INT;
    v_new_paid := (v_item->>'paid_amount_minor')::INT;
    v_new_status := v_item->>'status';
    v_expected_paid := (v_item->>'expected_paid_amount_minor')::INT;
    v_expected_status := v_item->>'expected_status';

    -- Invariant 1: Status must be in allowed Postgres check constraint set
    IF v_new_status NOT IN ('PAID', 'OVERDUE', 'UPCOMING', 'PARTIAL') THEN
      RAISE EXCEPTION 'INVARIANT_VIOLATION: Status "%" for schedule ID % is forbidden', v_new_status, v_id;
    END IF;

    -- Invariant 2: Paid amount cannot be negative
    IF v_new_paid < 0 THEN
      RAISE EXCEPTION 'INVARIANT_VIOLATION: Paid amount % for schedule ID % cannot be negative', v_new_paid, v_id;
    END IF;

    -- Pessimistic Lock & Optimistic State Check
    SELECT deal_id, amount_minor, paid_amount_minor, status, updated_at
    INTO v_current_deal_id, v_current_planned, v_current_paid, v_current_status, v_current_updated_at
    FROM deal_payment_schedules
    WHERE id = v_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ROW_NOT_FOUND: Schedule ID % does not exist', v_id;
    END IF;

    -- Security Guard: Deal ID must belong to approved set of installment deals
    IF NOT (v_current_deal_id = ANY(v_allowed_deal_ids)) THEN
      RAISE EXCEPTION 'SECURITY_VIOLATION: Deal ID % is not in the approved installment deal list', v_current_deal_id;
    END IF;

    -- Invariant 3: Paid amount cannot exceed planned amount
    IF v_new_paid > v_current_planned THEN
      RAISE EXCEPTION 'INVARIANT_VIOLATION: Paid amount % exceeds planned amount % for schedule ID %', v_new_paid, v_current_planned, v_id;
    END IF;

    -- Optimistic Lock State Check
    IF v_expected_paid IS NOT NULL AND v_current_paid <> v_expected_paid THEN
      RAISE EXCEPTION 'OPTIMISTIC_LOCK_MISMATCH: Schedule ID % paid_amount_minor changed (expected %, found %)', v_id, v_expected_paid, v_current_paid;
    END IF;

    IF v_expected_status IS NOT NULL AND v_current_status <> v_expected_status THEN
      RAISE EXCEPTION 'OPTIMISTIC_LOCK_MISMATCH: Schedule ID % status changed (expected %, found %)', v_id, v_expected_status, v_current_status;
    END IF;

    -- Perform UPDATE
    UPDATE deal_payment_schedules
    SET paid_amount_minor = v_new_paid,
        status = v_new_status,
        updated_at = NOW()
    WHERE id = v_id;

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'updated_count', v_count,
    'message', 'Atomic schedule recalculation applied successfully'
  );
END;
$$;

-- Strict Role Permissions (Security Hardening)
REVOKE EXECUTE ON FUNCTION recalculate_deal_schedules_atomic(JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION recalculate_deal_schedules_atomic(JSONB) FROM anon;
REVOKE EXECUTE ON FUNCTION recalculate_deal_schedules_atomic(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION recalculate_deal_schedules_atomic(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION recalculate_deal_schedules_atomic(JSONB) TO postgres;
