CREATE OR REPLACE FUNCTION public.telegram_finance_post_expense(p_telegram_id text, p_draft_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  d public.telegram_finance_expense_drafts%ROWTYPE;
  s public.telegram_finance_subscribers%ROWTYPE;
  v_amount bigint; v_currency varchar; v_rate numeric; v_original numeric;
  v_description text; v_result jsonb; v_date date;
  v_mode text; v_ids integer[]; v_shares jsonb := '[]'; v_count integer; v_project_count integer;
  v_expense integer; v_allocation public.cost_expense_allocations; v_label text;
BEGIN
  SELECT * INTO d FROM public.telegram_finance_expense_drafts WHERE id=p_draft_id AND telegram_id=p_telegram_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DRAFT_NOT_FOUND'; END IF;
  SELECT * INTO s FROM public.telegram_finance_subscribers WHERE telegram_id=p_telegram_id FOR SHARE;
  IF s.status <> 'APPROVED' OR NOT s.can_create_expense OR s.crm_user_id IS NULL
    OR (s.slot <> 'AKMALKHON' AND s.cash_desk_id IS DISTINCT FROM d.cash_desk_id) THEN
    RAISE EXCEPTION 'CASH_ACCESS_DENIED';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=s.crm_user_id AND is_active=1) THEN RAISE EXCEPTION 'CRM_USER_INACTIVE'; END IF;
  IF d.status='POSTED' THEN RETURN d.result; END IF;
  IF d.status<>'DRAFT' OR d.created_at < now()-interval '24 hours' THEN RAISE EXCEPTION 'DRAFT_EXPIRED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.dictionaries WHERE id=d.cash_desk_id AND type='CASH_DESK' AND is_active=true AND coalesce(code,'')<>'BANK_ACCOUNT' AND name !~* 'бартер') THEN RAISE EXCEPTION 'CASH_DESK_UNAVAILABLE'; END IF;
  v_amount := (d.payload->>'amount_minor')::bigint;
  v_currency := d.payload->>'currency';
  v_date := (d.payload->>'date')::date;
  IF v_amount<=0 OR v_amount>2147483647 OR v_currency NOT IN ('USD','TJS') OR v_date>(now() AT TIME ZONE 'Asia/Dushanbe')::date THEN RAISE EXCEPTION 'INVALID_EXPENSE'; END IF;
  IF coalesce(d.payload->>'category','') IN ('Конвертация валюты','Внутренние перемещения между кассами','INTERNAL_TRANSFER','CURRENCY_CONVERSION') THEN RAISE EXCEPTION 'INVALID_CATEGORY'; END IF;
  v_description := d.payload->>'description';
  IF length(coalesce(v_description,''))<1 OR length(v_description)>1000 OR length(coalesce(d.payload->>'recipient',''))<1 THEN RAISE EXCEPTION 'INVALID_EXPENSE'; END IF;
  v_mode := d.payload->'cost'->>'mode';
  IF v_mode IS NULL OR v_mode NOT IN ('DIRECT','SHARED','MATERIAL') THEN RAISE EXCEPTION 'COST_SELECTION_REQUIRED'; END IF;
  IF jsonb_typeof(d.payload->'cost'->'buildings') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'COST_INVALID_BLOCKS'; END IF;
  SELECT coalesce(array_agg(x::integer),'{}'::integer[]) INTO v_ids FROM jsonb_array_elements_text(d.payload->'cost'->'buildings') x;
  v_count := cardinality(v_ids);
  IF v_count>100 OR v_count<>(SELECT count(distinct x) FROM unnest(v_ids) x) THEN RAISE EXCEPTION 'COST_INVALID_BLOCKS'; END IF;
  IF (d.payload->>'category') ~* 'бетон|арматур' AND v_mode<>'MATERIAL' THEN RAISE EXCEPTION 'COST_MATERIAL_USAGE_REQUIRED'; END IF;
  IF v_mode='MATERIAL' THEN
    IF v_count<>0 THEN RAISE EXCEPTION 'COST_INVALID_BLOCKS'; END IF;
    v_mode:='UNASSIGNED'; v_label:='Оплата бетона / арматуры через Telegram; требуется связь с фактическим использованием';
  ELSE
    IF (v_mode='DIRECT' AND v_count<>1) OR (v_mode='SHARED' AND v_count<2) THEN RAISE EXCEPTION 'COST_INVALID_BLOCKS'; END IF;
    PERFORM 1 FROM public.buildings WHERE id=any(v_ids) ORDER BY id FOR SHARE;
    IF v_count<>(SELECT count(*) FROM public.buildings b JOIN public.projects p ON p.id=b.project_id WHERE b.id=any(v_ids) AND b.archived_at IS NULL AND p.archived_at IS NULL) THEN RAISE EXCEPTION 'COST_BLOCK_UNAVAILABLE'; END IF;
    SELECT count(distinct project_id) INTO v_project_count FROM public.buildings WHERE id=any(v_ids);
    IF v_project_count<>1 THEN RAISE EXCEPTION 'COST_CROSS_PROJECT'; END IF;
    IF v_mode='DIRECT' THEN
      v_shares:=jsonb_build_array(jsonb_build_object('building_id',v_ids[1],'weight',1));
    ELSE
      PERFORM 1 FROM public.cost_building_bases WHERE building_id=any(v_ids) ORDER BY building_id FOR SHARE;
      IF v_count<>(SELECT count(*) FROM public.cost_building_bases WHERE building_id=any(v_ids) AND sellable_area_m2>0) THEN RAISE EXCEPTION 'COST_AREA_MISSING'; END IF;
      SELECT jsonb_agg(jsonb_build_object('building_id',building_id,'weight',sellable_area_m2,'basis_version',version) ORDER BY building_id) INTO v_shares FROM public.cost_building_bases WHERE building_id=any(v_ids);
    END IF;
    SELECT string_agg(p.name||' — '||b.name,', ' ORDER BY b.id) INTO v_label FROM public.buildings b JOIN public.projects p ON p.id=b.project_id WHERE b.id=any(v_ids);
    IF v_mode='SHARED' THEN v_label:=v_label||' (общие расходы по продаваемой площади)'; END IF;
  END IF;
  v_original := v_amount/100.0;
  IF v_currency='TJS' AND d.payload->>'source_currency'='USD' THEN
    v_rate := (d.payload->>'exchange_rate')::numeric;
    IF v_rate IS NULL OR v_rate<=0 THEN RAISE EXCEPTION 'INVALID_EXCHANGE_RATE'; END IF;
    v_amount := round(v_original/v_rate*100)::bigint;
    IF v_amount<=0 OR v_amount>2147483647 THEN RAISE EXCEPTION 'INVALID_EXPENSE'; END IF;
    v_currency := 'USD';
    v_description := v_description || ' • Оплачено: ' || v_original || ' TJS; списание из USD по курсу ' || v_rate;
  END IF;
  v_result := public.create_atomic_expense(
    p_cash_desk_id=>d.cash_desk_id,p_amount_minor=>v_amount,p_currency=>v_currency,
    p_expense_date=>v_date,p_category=>d.payload->>'category',p_recipient=>d.payload->>'recipient',
    p_description=>v_description,p_user_id=>s.crm_user_id,p_method=>'CASH',
    p_exchange_rate=>v_rate,p_amount_usd=>CASE WHEN v_currency='USD' THEN v_amount/100.0 ELSE NULL END,
    p_amount_tjs=>CASE WHEN d.payload->>'currency'='TJS' THEN v_original ELSE NULL END,
    p_idempotency_key=>('telegram-rko:'||d.id)::varchar
  );
  IF v_result->>'success' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'COST_EXPENSE_NOT_CREATED'; END IF;
  v_expense:=(v_result->>'expense_id')::integer;
  INSERT INTO public.cost_expense_allocations(expense_id,mode,shares,reason,updated_by)
  VALUES(v_expense,v_mode,v_shares,'Telegram РКО: '||v_label,s.crm_user_id) RETURNING * INTO v_allocation;
  INSERT INTO public.cost_audit(entity,entity_id,before_data,after_data,actor_id) VALUES('ALLOCATION',v_expense,NULL,to_jsonb(v_allocation),s.crm_user_id);
  v_result:=v_result||jsonb_build_object('cost_mode',v_mode,'cost_label',v_label);
  UPDATE public.telegram_finance_expense_drafts SET status='POSTED',result=v_result WHERE id=d.id;
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.telegram_finance_post_expense(text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.telegram_finance_post_expense(text,uuid) TO service_role;
