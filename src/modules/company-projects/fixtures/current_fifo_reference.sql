-- Reference snapshot: running TOZON DB, 2026-11-10. Calculation body matches test DB.
-- Test DB uses invoker privileges; production retains its existing definer setup.
-- Used by tests only; not a migration and does not replace the deployed calculation.
CREATE OR REPLACE FUNCTION public.recalculate_deal_schedules_internal(p_deal_id integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pmt RECORD;
  v_pmt_usd_minor INT;
  v_total_active_paid INT := 0;
  v_down_payment_plan INT;
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

  FOR v_pmt IN
    SELECT id, amount_minor, currency, exchange_rate, amount_usd
    FROM public.payments
    WHERE deal_id = p_deal_id
      AND status IN ('ACTIVE', 'POSTED')
      AND status <> 'VOIDED'
  LOOP
    IF COALESCE(v_pmt.currency, 'USD') = 'USD' THEN
      v_pmt_usd_minor := COALESCE(
        ROUND(v_pmt.amount_usd * 100)::INT,
        v_pmt.amount_minor
      );
    ELSE
      -- Non-USD payment (e.g. TJS)
      IF v_pmt.amount_usd IS NOT NULL AND v_pmt.amount_usd > 0 THEN
        v_pmt_usd_minor := ROUND(v_pmt.amount_usd * 100)::INT;
      ELSIF v_pmt.exchange_rate IS NOT NULL AND v_pmt.exchange_rate > 0 THEN
        v_pmt_usd_minor := ROUND((v_pmt.amount_minor::NUMERIC / 100.0) / v_pmt.exchange_rate * 100)::INT;
      ELSE
        RAISE EXCEPTION 'MISSING_EXCHANGE_RATE: Payment ID % (% %) does not have a valid USD equivalent or exchange rate',
          v_pmt.id, v_pmt.amount_minor, v_pmt.currency;
      END IF;
    END IF;

    v_total_active_paid := v_total_active_paid + v_pmt_usd_minor;
  END LOOP;

  v_down_payment_covered := LEAST(v_total_active_paid, v_down_payment_plan);
  v_pool := GREATEST(0, v_total_active_paid - v_down_payment_covered);

  FOR v_sched IN
    SELECT id, due_date, amount_minor, paid_amount_minor, status
    FROM public.deal_payment_schedules
    WHERE deal_id = p_deal_id
    ORDER BY due_date::date, id
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
    ELSIF v_remaining > 0 AND v_sched.due_date::date < v_today THEN
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
$function$
