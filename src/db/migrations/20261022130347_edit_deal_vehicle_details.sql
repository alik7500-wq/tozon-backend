-- Add vehicle metadata to the existing audited edit transaction without weakening paid-deal protection.
CREATE OR REPLACE FUNCTION public.update_deal_vehicle_atomic(
  p_deal_id bigint, p_user_id bigint, p_updates_json jsonb,
  p_lead_updates_json jsonb DEFAULT NULL, p_schedules_json jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  v_vehicle jsonb;
  v_payment_type text;
  v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_user_id AND role='ADMIN' AND is_active=1) THEN
    RAISE EXCEPTION 'Редактирование автомобиля доступно только администратору';
  END IF;
  IF jsonb_typeof(p_updates_json) IS DISTINCT FROM 'object' OR NOT (p_updates_json ? 'vehicle_details') THEN
    RAISE EXCEPTION 'Укажите данные автомобиля';
  END IF;
  SELECT payment_type INTO v_payment_type FROM public.deals WHERE id=p_deal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Сделка не найдена'; END IF;
  IF coalesce(p_updates_json->>'payment_type', v_payment_type) <> 'PARTIAL_BARTER' THEN
    RAISE EXCEPTION 'Данные автомобиля доступны для сделки Бартер + Доплата';
  END IF;
  v_vehicle := nullif(p_updates_json->'vehicle_details','null'::jsonb);
  IF v_vehicle IS NOT NULL THEN
    IF jsonb_typeof(v_vehicle) <> 'object' THEN RAISE EXCEPTION 'Некорректные данные автомобиля'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each(v_vehicle) AS e(key,value)
      WHERE e.key NOT IN ('brand_model','production_year','color','registration_number','vin','registration_certificate','mileage_km','handover_date','condition','accessories','encumbrances')
        OR jsonb_typeof(e.value) <> 'string') THEN
      RAISE EXCEPTION 'Недопустимое поле данных автомобиля';
    END IF;
  END IF;
  -- Existing function enforces paid financial locks, saves metadata and records all input keys in the audit.
  PERFORM public.update_deal_atomic(p_deal_id,p_user_id,p_updates_json,p_lead_updates_json,p_schedules_json);
  UPDATE public.deals SET vehicle_details=v_vehicle WHERE id=p_deal_id;
  SELECT to_jsonb(d) INTO v_result FROM public.deals d WHERE id=p_deal_id;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.update_deal_vehicle_atomic(bigint,bigint,jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_deal_vehicle_atomic(bigint,bigint,jsonb,jsonb,jsonb) TO service_role, postgres;
NOTIFY pgrst, 'reload schema';
