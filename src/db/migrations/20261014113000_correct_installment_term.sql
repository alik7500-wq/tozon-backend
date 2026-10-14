CREATE OR REPLACE FUNCTION public.correct_installment_term_atomic(p_deal_id bigint,p_user_id bigint,p_changes jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE
 d public.deals%ROWTYPE; old_deal jsonb; old_plan jsonb; result jsonb;
 months integer; plan bigint; paid bigint; pool bigint; amount bigint; allocated bigint;
 i integer; due text; sid bigint; base_date date;
 today text := to_char(now() AT TIME ZONE 'Asia/Dushanbe','YYYY-MM-DD');
 stamp text := clock_timestamp()::text;
 metadata jsonb;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_user_id AND role='ADMIN' AND is_active=1) THEN
   RAISE EXCEPTION 'Изменение срока доступно только администратору';
 END IF;
 IF jsonb_typeof(p_changes) IS DISTINCT FROM 'object' OR EXISTS (
 SELECT 1 FROM jsonb_object_keys(p_changes) k WHERE k NOT IN
 ('installment_months','expected_updated_at','contract_number','deal_date','lead_name','lead_phone',
 'passport_series','passport_number','inn','responsible_user_id','reservation_expires_at','barter_description')) THEN
 RAISE EXCEPTION 'Стоимость и первый взнос нельзя изменять вместе со сроком оплаченной сделки';
 END IF;
 months := (p_changes->>'installment_months')::integer;
 IF months IS NULL OR months<1 OR months>60 THEN RAISE EXCEPTION 'Укажите срок рассрочки от 1 до 60 месяцев'; END IF;
 SELECT * INTO d FROM public.deals WHERE id=p_deal_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Сделка не найдена'; END IF;
 IF d.status NOT IN ('SIGNED','RESERVED') OR d.payment_type<>'INSTALLMENT' THEN
 RAISE EXCEPTION 'Изменение срока доступно только для действующей рассрочки'; END IF;
 IF p_changes->>'expected_updated_at' IS NULL OR
 d.updated_at::timestamptz IS DISTINCT FROM (p_changes->>'expected_updated_at')::timestamptz THEN
 RAISE EXCEPTION 'STALE_DEAL'; END IF;
 -- A term correction must retain the original start date.
 IF p_changes ? 'deal_date' AND p_changes->>'deal_date' IS DISTINCT FROM d.deal_date THEN
 RAISE EXCEPTION 'Сначала сохраните дату договора отдельно от изменения срока'; END IF;
 old_deal := to_jsonb(d);
 PERFORM id FROM public.payments WHERE deal_id=d.id ORDER BY id FOR UPDATE;
 PERFORM id FROM public.deal_payment_schedules WHERE deal_id=d.id ORDER BY id FOR UPDATE;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.payment_number,x.id),'[]'::jsonb)
 INTO old_plan FROM public.deal_payment_schedules x WHERE x.deal_id=d.id;
 IF EXISTS (SELECT 1 FROM public.deal_payment_schedules WHERE deal_id=d.id GROUP BY payment_number HAVING count(*)>1)
 OR EXISTS (SELECT 1 FROM public.deal_payment_schedules WHERE deal_id=d.id AND (payment_number IS NULL OR payment_number<1)) THEN
 RAISE EXCEPTION 'Некорректная нумерация графика. Требуется проверка'; END IF;
 plan := d.final_price_minor-d.down_payment_minor;
 IF plan<months THEN RAISE EXCEPTION 'Сумма рассрочки слишком мала для указанного срока'; END IF;
 base_date := coalesce(nullif(d.deal_date,''),substring(d.created_at from 1 for 10))::date;
 IF base_date IS NULL THEN RAISE EXCEPTION 'Укажите дату договора'; END IF;
 SELECT coalesce(sum(amount_minor),0) INTO paid FROM public.payments
 WHERE deal_id=d.id AND status IN ('ACTIVE','POSTED');
 pool := greatest(0,paid-d.down_payment_minor);
 -- Retain existing IDs and receipt references; append only missing periods.
 FOR i IN 1..months LOOP
   due := to_char(base_date+make_interval(months=>i),'YYYY-MM-DD');
   amount := plan/months + CASE WHEN i<=plan%months THEN 1 ELSE 0 END;
   allocated := least(amount,pool); pool:=pool-allocated;
   SELECT id INTO sid FROM public.deal_payment_schedules WHERE deal_id=d.id AND payment_number=i;
   IF sid IS NULL THEN
    INSERT INTO public.deal_payment_schedules(deal_id,payment_number,due_date,amount_minor,paid_amount_minor,status,created_at,updated_at)
    VALUES(d.id,i,due,amount,allocated,CASE WHEN allocated>=amount THEN 'PAID' WHEN allocated>0 THEN 'PARTIAL' WHEN due<today THEN 'OVERDUE' ELSE 'UPCOMING' END,stamp,stamp);
   ELSE
    UPDATE public.deal_payment_schedules SET due_date=due,amount_minor=amount,paid_amount_minor=allocated,
    status=CASE WHEN allocated>=amount THEN 'PAID' WHEN allocated>0 THEN 'PARTIAL' WHEN due<today THEN 'OVERDUE' ELSE 'UPCOMING' END,updated_at=stamp WHERE id=sid;
   END IF;
 END LOOP;
 DELETE FROM public.deal_payment_schedules WHERE deal_id=d.id AND payment_number>months;
 UPDATE public.deals SET installment_months=months,updated_at=stamp WHERE id=d.id;
 metadata := p_changes - ARRAY['installment_months','expected_updated_at','lead_name','lead_phone','passport_series','passport_number','inn'];
 -- Existing metadata operation participates in this same transaction.
 PERFORM public.update_deal_atomic(d.id,p_user_id,metadata,
 jsonb_strip_nulls(jsonb_build_object('full_name',nullif(p_changes->>'lead_name',''),
 'phone',nullif(p_changes->>'lead_phone',''),'passport_series',p_changes->>'passport_series',
 'passport_number',p_changes->>'passport_number','inn',p_changes->>'inn')),NULL);
 SELECT to_jsonb(x) INTO result FROM public.deals x WHERE x.id=d.id;
 INSERT INTO public.deal_audit_logs(deal_id,user_id,action,changes_json)
 VALUES(d.id,p_user_id,'CORRECT_INSTALLMENT_TERM',jsonb_build_object('old',old_deal,'new',result,
 'old_schedules',old_plan,'new_schedules',(SELECT jsonb_agg(to_jsonb(x) ORDER BY payment_number) FROM public.deal_payment_schedules x WHERE x.deal_id=d.id),'paid_minor',paid));
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.correct_installment_term_atomic(bigint,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.correct_installment_term_atomic(bigint,bigint,jsonb) TO service_role;
