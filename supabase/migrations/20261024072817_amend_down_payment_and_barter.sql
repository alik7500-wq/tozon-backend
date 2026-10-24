BEGIN;
CREATE OR REPLACE FUNCTION public.amend_deal_atomic(p_deal_id bigint, p_user_id bigint, p_amendment jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
 d public.deals%ROWTYPE; u public.units%ROWTYPE;
 old_deal jsonb; old_schedules jsonb; result jsonb; old_unit jsonb;
 target_id bigint; price bigint; rate bigint; plan bigint; n bigint; old_plan numeric;
 down_pmt bigint; barter bigint; payment_kind text; field_name text;
 paid bigint; pool bigint; allocated bigint; previous_total numeric := 0; next_total numeric;
 amount bigint; sched record; old_project bigint; new_project bigint; new_currency text;
 today text := to_char(now() AT TIME ZONE 'Asia/Dushanbe', 'YYYY-MM-DD');
 stamp text := clock_timestamp()::text;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_user_id AND role='ADMIN' AND is_active=1) THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Изменение доступно только действующему администратору';
 END IF;
 IF jsonb_typeof(p_amendment) IS DISTINCT FROM 'object' OR
    EXISTS (SELECT 1 FROM jsonb_object_keys(p_amendment) k WHERE k NOT IN
      ('unit_id','final_price_minor','deal_price_per_m2_minor','reason','expected_updated_at','down_payment_minor','payment_type','barter_amount_minor','barter_description','vehicle_details')) THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Недопустимые поля';
 END IF;
 IF nullif(btrim(p_amendment->>'reason'),'') IS NULL OR length(p_amendment->>'reason')>2000 THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Укажите причину изменения';
 END IF;
 target_id := (p_amendment->>'unit_id')::bigint;
 price := (p_amendment->>'final_price_minor')::bigint;
 rate := (p_amendment->>'deal_price_per_m2_minor')::bigint;
 IF target_id IS NULL OR price IS NULL OR rate IS NULL OR target_id<=0 OR price<=0 OR rate<=0
    OR price>2147483647 OR rate>2147483647 THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Неверные квартира или стоимость';
 END IF;
 SELECT * INTO d FROM public.deals WHERE id=p_deal_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'DEAL_NOT_FOUND'; END IF;
 IF d.status NOT IN ('RESERVED','SIGNED') OR d.payment_type NOT IN ('FULL','INSTALLMENT','PARTIAL_BARTER') THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Изменение доступно для активной продажи или брони';
 END IF;
 IF p_amendment->>'expected_updated_at' IS NULL OR
    d.updated_at::timestamptz IS DISTINCT FROM (p_amendment->>'expected_updated_at')::timestamptz THEN
   RAISE EXCEPTION 'STALE_DEAL';
 END IF;
 FOREACH field_name IN ARRAY ARRAY['down_payment_minor','barter_amount_minor'] LOOP
   IF p_amendment ? field_name AND (jsonb_typeof(p_amendment->field_name) IS DISTINCT FROM 'number'
      OR (p_amendment->>field_name) !~ '^[0-9]+$' OR (p_amendment->>field_name)::numeric>2147483647) THEN
     RAISE EXCEPTION 'AMENDMENT_INVALID: Неверная сумма первоначального взноса или бартера';
   END IF;
 END LOOP;
 down_pmt := coalesce((p_amendment->>'down_payment_minor')::bigint,d.down_payment_minor,0);
 barter := coalesce((p_amendment->>'barter_amount_minor')::bigint,d.barter_amount_minor,0);
 payment_kind := coalesce(p_amendment->>'payment_type',d.payment_type);
 IF payment_kind IS NULL OR (payment_kind<>d.payment_type AND NOT
    (d.payment_type IN ('INSTALLMENT','FULL') AND payment_kind='PARTIAL_BARTER')) THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Допустимо только добавление автомобиля к действующему договору';
 END IF;
 IF down_pmt<0 OR down_pmt>price OR barter<0 OR barter>down_pmt THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Стоимость автомобиля должна входить в первый взнос, а первый взнос не может превышать цену договора';
 END IF;
 IF payment_kind<>'PARTIAL_BARTER' AND (barter>0 OR p_amendment ? 'vehicle_details' OR p_amendment ? 'barter_description') THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Автомобиль доступен для формы Бартер + Доплата';
 END IF;
 IF d.payment_type<>'PARTIAL_BARTER' AND payment_kind='PARTIAL_BARTER' AND (barter<=0 OR nullif(btrim(p_amendment->>'barter_description'),'') IS NULL) THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Укажите описание и положительную стоимость автомобиля';
 END IF;
 IF p_amendment ? 'barter_description' AND (jsonb_typeof(p_amendment->'barter_description') IS DISTINCT FROM 'string' OR length(p_amendment->>'barter_description')>2000) THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Неверное описание бартера';
 END IF;
 IF p_amendment ? 'vehicle_details' AND p_amendment->'vehicle_details'<>'null'::jsonb THEN
   IF jsonb_typeof(p_amendment->'vehicle_details') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'AMENDMENT_INVALID: Неверные данные автомобиля'; END IF;
   IF EXISTS (SELECT 1 FROM jsonb_each(p_amendment->'vehicle_details') e
      WHERE e.key NOT IN ('brand_model','production_year','color','registration_number','vin','registration_certificate','mileage_km','handover_date','condition','accessories','encumbrances')
      OR jsonb_typeof(e.value) IS DISTINCT FROM 'string' OR length(e.value #>> '{}')>1000) THEN
     RAISE EXCEPTION 'AMENDMENT_INVALID: Недопустимые данные автомобиля';
   END IF;
 END IF;
 old_deal := to_jsonb(d);
 -- Deterministic unit locks prevent competing swaps and sales from partially updating the board.
 PERFORM id FROM public.units WHERE id IN (d.unit_id,target_id) ORDER BY id FOR UPDATE;
 SELECT to_jsonb(x) INTO old_unit FROM public.units x WHERE id=d.unit_id;
 SELECT * INTO u FROM public.units WHERE id=target_id;
 IF NOT FOUND OR u.archived_at IS NOT NULL OR u.area_m2_x100<=0 THEN
   RAISE EXCEPTION 'UNIT_UNAVAILABLE';
 END IF;
 IF target_id<>d.unit_id AND (u.status<>'AVAILABLE' OR EXISTS
    (SELECT 1 FROM public.deals WHERE unit_id=target_id AND id<>d.id AND status IN ('RESERVED','SIGNED'))) THEN
   RAISE EXCEPTION 'UNIT_UNAVAILABLE';
 END IF;
 SELECT b.project_id INTO old_project FROM public.units x JOIN public.floors f ON f.id=x.floor_id
 JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id WHERE x.id=d.unit_id;
 SELECT b.project_id,p.currency INTO new_project,new_currency FROM public.floors f
 JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id
 JOIN public.projects p ON p.id=b.project_id WHERE f.id=u.floor_id;
 IF old_project IS NULL OR new_project IS DISTINCT FROM old_project OR new_currency IS DISTINCT FROM d.currency THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Выберите квартиру в том же проекте и валюте';
 END IF;
 IF price+d.discount_minor>2147483647 OR price<down_pmt THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Стоимость ниже договорного первого взноса или превышает допустимую сумму';
 END IF;
 PERFORM id FROM public.payments WHERE deal_id=d.id ORDER BY id FOR UPDATE;
 PERFORM id FROM public.deal_payment_schedules WHERE deal_id=d.id ORDER BY id FOR UPDATE;
 SELECT coalesce(sum(amount_minor),0) INTO paid FROM public.payments
 WHERE deal_id=d.id AND status IN ('ACTIVE','POSTED');
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.due_date,x.id),'[]'::jsonb),count(*),coalesce(sum(x.amount_minor),0)
 INTO old_schedules,n,old_plan FROM public.deal_payment_schedules x WHERE deal_id=d.id;
 plan := price-down_pmt;
 IF payment_kind IN ('INSTALLMENT','PARTIAL_BARTER') AND plan>0 AND n=0 THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Сначала восстановите график рассрочки';
 END IF;
 IF n>0 AND (plan<n OR old_plan<=0) THEN
   RAISE EXCEPTION 'AMENDMENT_INVALID: Сумма графика слишком мала; требуется отдельное согласование графика';
 END IF;
 UPDATE public.deals SET unit_id=target_id,final_price_minor=price,
 base_price_minor=price+discount_minor,deal_price_per_m2_minor=rate,down_payment_minor=down_pmt,payment_type=payment_kind,
 barter_amount_minor=barter,
 barter_description=CASE WHEN p_amendment ? 'barter_description' THEN nullif(btrim(p_amendment->>'barter_description'),'') ELSE barter_description END,
 vehicle_details=CASE WHEN p_amendment ? 'vehicle_details' THEN nullif(p_amendment->'vehicle_details','null'::jsonb) ELSE vehicle_details END,
 updated_at=stamp WHERE id=d.id;
 IF target_id<>d.unit_id THEN
   UPDATE public.units SET status='AVAILABLE',updated_at=stamp WHERE id=d.unit_id;
   UPDATE public.units SET status=CASE WHEN d.status='SIGNED' THEN 'SOLD' ELSE 'RESERVED' END,
   updated_at=stamp WHERE id=target_id;
 END IF;
 -- Keep schedule IDs (including payment FK references), dates and row count. Rescale agreed
 -- amounts proportionally, reserve one cent per row, and assign rounding by cumulative totals.
 pool := greatest(0,paid-down_pmt);
 FOR sched IN SELECT * FROM public.deal_payment_schedules WHERE deal_id=d.id ORDER BY due_date,id LOOP
   next_total := previous_total+sched.amount_minor;
   amount := 1+floor((plan-n)::numeric*next_total/old_plan)-floor((plan-n)::numeric*previous_total/old_plan);
   allocated := least(amount,pool); pool:=pool-allocated;
   UPDATE public.deal_payment_schedules SET amount_minor=amount,paid_amount_minor=allocated,
   status=CASE WHEN allocated>=amount THEN 'PAID' WHEN allocated>0 THEN 'PARTIAL'
     WHEN due_date<today THEN 'OVERDUE' ELSE 'UPCOMING' END,updated_at=stamp WHERE id=sched.id;
   previous_total:=next_total;
 END LOOP;
 SELECT to_jsonb(x) INTO result FROM public.deals x WHERE id=d.id;
 INSERT INTO public.deal_audit_logs(deal_id,user_id,action,changes_json)
 VALUES(d.id,p_user_id,'AMEND_CONTRACT',jsonb_build_object('reason',btrim(p_amendment->>'reason'),
   'old',old_deal,'new',result,'old_unit',old_unit,'new_unit',to_jsonb(u),'old_schedules',old_schedules,
   'new_schedules',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.due_date,x.id),'[]'::jsonb)
     FROM public.deal_payment_schedules x WHERE x.deal_id=d.id),
   'paid_minor',paid,'remaining_minor',greatest(0,price-paid),'overpayment_minor',greatest(0,paid-price)));
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.amend_deal_atomic(bigint,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.amend_deal_atomic(bigint,bigint,jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
