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
  UPDATE public.telegram_finance_expense_drafts SET status='POSTED',result=v_result WHERE id=d.id;
  RETURN v_result;
END;
$function$
