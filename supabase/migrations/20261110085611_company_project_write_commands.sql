-- Isolated test pilot: writes are separately granted, not implied by read access.
ALTER TABLE public.company_workspace_access ADD COLUMN write_sections text[] NOT NULL DEFAULT '{}'
 CHECK(write_sections <@ ARRAY['deals.write','finance.payments.write','finance.expenses.write','construction.stock.write']::text[]);
CREATE TABLE public.company_project_parties(
 party_id uuid PRIMARY KEY REFERENCES public.construction_parties(id) ON DELETE RESTRICT,
 company_project_id uuid NOT NULL REFERENCES public.company_projects(id) ON DELETE RESTRICT
);
CREATE INDEX company_project_parties_parent ON public.company_project_parties(company_project_id);
ALTER TABLE public.company_project_parties ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_project_parties FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.company_project_parties TO service_role;
ALTER TABLE public.deals ADD COLUMN company_project_id uuid REFERENCES public.company_projects(id) ON DELETE RESTRICT;
ALTER TABLE public.deals ADD COLUMN company_director_snapshot jsonb;
CREATE INDEX deals_company_project ON public.deals(company_project_id);
CREATE TABLE public.company_project_commands(
 request_id uuid PRIMARY KEY,
 company_project_id uuid NOT NULL REFERENCES public.company_projects(id) ON DELETE RESTRICT,
 actor_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK(kind IN ('DEAL_DRAFT','PAYMENT','EXPENSE','STOCK_POST')),
 payload jsonb NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX company_project_commands_parent ON public.company_project_commands(company_project_id);
CREATE INDEX company_project_commands_actor ON public.company_project_commands(actor_id);
ALTER TABLE public.company_project_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_project_commands FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.company_project_commands FROM service_role;
GRANT SELECT,INSERT ON public.company_project_commands TO service_role;

-- Protect newly scoped draft links even if edited through a legacy service path.
CREATE FUNCTION tozon_internal.check_company_deal_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $guard$
BEGIN
 IF TG_OP='UPDATE' AND OLD.company_project_id IS NOT NULL AND NEW.company_project_id IS DISTINCT FROM OLD.company_project_id THEN
  RAISE EXCEPTION 'SCOPED_DEAL_CANNOT_CHANGE_PROJECT' USING ERRCODE='23514';
 END IF;
 IF NEW.company_project_id IS NULL THEN RETURN NEW;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.units u JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id JOIN public.company_project_complexes cp ON cp.complex_id=b.project_id
   WHERE u.id=NEW.unit_id AND cp.company_project_id=NEW.company_project_id) OR
  NOT EXISTS(SELECT 1 FROM public.company_project_leads WHERE lead_id=NEW.lead_id AND company_project_id=NEW.company_project_id) THEN
  RAISE EXCEPTION 'SCOPED_DEAL_LINK_MISMATCH' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION tozon_internal.check_company_deal_links() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER company_deal_links BEFORE INSERT OR UPDATE OF company_project_id,unit_id,lead_id ON public.deals FOR EACH ROW EXECUTE FUNCTION tozon_internal.check_company_deal_links();

CREATE FUNCTION public.execute_company_project_command(p_actor integer,p_project uuid,p_request uuid,p_kind text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
 v_read text;v_write text;v_allowed text[];v_keys text[];v_saved public.company_project_commands;
 v_unit public.units;v_deal public.deals;v_company public.company_projects;
 v_currency text;v_amount bigint;v_rate numeric;v_date date;v_cash uuid;v_result jsonb;v_id integer;v_stock uuid;v_doc jsonb;v_base bigint;v_paid bigint;
BEGIN
 v_read:=CASE p_kind WHEN 'DEAL_DRAFT' THEN 'deals' WHEN 'PAYMENT' THEN 'payments' WHEN 'EXPENSE' THEN 'expenses' WHEN 'STOCK_POST' THEN 'warehouses' ELSE NULL END;
 v_write:=CASE p_kind WHEN 'DEAL_DRAFT' THEN 'deals.write' WHEN 'PAYMENT' THEN 'finance.payments.write' WHEN 'EXPENSE' THEN 'finance.expenses.write' WHEN 'STOCK_POST' THEN 'construction.stock.write' END;
 IF v_read IS NULL OR p_request IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'INVALID_WORKSPACE_COMMAND' USING ERRCODE='22023';END IF;
 -- Locks serialize changes to the actor/profile/grant for the duration of posting.
 PERFORM 1 FROM public.users u JOIN public.company_workspace_users w ON w.user_id=u.id WHERE u.id=p_actor AND u.is_active=1 AND w.enabled AND coalesce(u.permissions,'[]'::jsonb)?'company.project-only' FOR SHARE OF u,w;
 IF NOT FOUND THEN RAISE EXCEPTION 'WORKSPACE_ACCESS_DENIED' USING ERRCODE='42501';END IF;
 SELECT write_sections INTO v_allowed FROM public.company_workspace_access WHERE user_id=p_actor AND company_project_id=p_project AND enabled FOR SHARE;
 IF NOT FOUND OR NOT(v_write=ANY(v_allowed)) THEN RAISE EXCEPTION 'WORKSPACE_WRITE_DENIED' USING ERRCODE='42501';END IF;
 PERFORM public.read_company_project_workspace(p_actor,p_project,v_read,NULL,'',1);
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('workspace-command:'||p_request::text,0));
 SELECT * INTO v_saved FROM public.company_project_commands WHERE request_id=p_request;
 IF FOUND THEN
  IF v_saved.company_project_id<>p_project OR v_saved.actor_id<>p_actor OR v_saved.kind<>p_kind OR v_saved.payload<>p_payload THEN RAISE EXCEPTION 'WORKSPACE_REQUEST_REUSED' USING ERRCODE='23505';END IF;
  RETURN v_saved.result||jsonb_build_object('idempotent',true);
 END IF;
 -- Hold all relevant project mappings until the command and its ledgers commit.
 PERFORM 1 FROM public.company_project_complexes WHERE company_project_id=p_project FOR SHARE;
 PERFORM 1 FROM public.company_project_leads WHERE company_project_id=p_project FOR SHARE;
 PERFORM 1 FROM public.company_project_cash_desks WHERE company_project_id=p_project FOR SHARE;
 PERFORM 1 FROM public.company_project_warehouses WHERE company_project_id=p_project FOR SHARE;
 PERFORM 1 FROM public.company_project_parties WHERE company_project_id=p_project FOR SHARE;
 SELECT * INTO STRICT v_company FROM public.company_projects WHERE id=p_project FOR SHARE;
 v_keys:=CASE p_kind
  WHEN 'DEAL_DRAFT' THEN ARRAY['lead_id','unit_id','final_price_minor','down_payment_minor','payment_type','installment_months','date']
  WHEN 'PAYMENT' THEN ARRAY['cash_desk_id','amount_minor','currency','exchange_rate','date','deal_id','comment']
  WHEN 'EXPENSE' THEN ARRAY['cash_desk_id','amount_minor','currency','exchange_rate','date','category','recipient','description','settlement_party_id','settlement_account']
  WHEN 'STOCK_POST' THEN ARRAY['kind','date','currency','warehouse_id','destination_id','party_id','complex_id','work_type','basis','lines'] END;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE NOT(k=ANY(v_keys))) THEN RAISE EXCEPTION 'UNSUPPORTED_COMMAND_FIELD' USING ERRCODE='22023';END IF;
 IF p_payload->>'date' IS NULL OR p_payload->>'date' !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'INVALID_DATE' USING ERRCODE='22023';END IF;
 v_date:=(p_payload->>'date')::date;
 IF p_kind='DEAL_DRAFT' THEN
  SELECT u.* INTO v_unit FROM public.units u JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id JOIN public.projects c ON c.id=b.project_id JOIN public.company_project_complexes cp ON cp.complex_id=c.id
  WHERE u.id=(p_payload->>'unit_id')::integer AND cp.company_project_id=p_project AND u.archived_at IS NULL AND f.archived_at IS NULL AND s.archived_at IS NULL AND b.archived_at IS NULL AND c.archived_at IS NULL FOR UPDATE OF u;
  IF NOT FOUND THEN RAISE EXCEPTION 'UNIT_OUTSIDE_PROJECT' USING ERRCODE='42501';END IF;
  IF v_unit.status<>'AVAILABLE' OR EXISTS(SELECT 1 FROM public.deals WHERE unit_id=v_unit.id AND status IN ('DRAFT','RESERVED','SIGNED')) THEN RAISE EXCEPTION 'UNIT_UNAVAILABLE' USING ERRCODE='23505';END IF;
  PERFORM 1 FROM public.leads l JOIN public.company_project_leads cp ON cp.lead_id=l.id WHERE l.id=(p_payload->>'lead_id')::integer AND cp.company_project_id=p_project AND l.archived_at IS NULL FOR UPDATE OF l;
  IF NOT FOUND THEN RAISE EXCEPTION 'LEAD_OUTSIDE_PROJECT' USING ERRCODE='42501';END IF;
  v_amount:=(p_payload->>'final_price_minor')::bigint;
  IF v_amount IS NULL OR v_amount<=0 OR v_amount>2147483647 OR (p_payload->>'final_price_minor')::numeric<>v_amount OR
     coalesce((p_payload->>'down_payment_minor')::bigint,0) NOT BETWEEN 0 AND v_amount OR
     coalesce(p_payload->>'payment_type','FULL') NOT IN ('FULL','INSTALLMENT') OR
     (coalesce(p_payload->>'payment_type','FULL')='FULL' AND coalesce((p_payload->>'installment_months')::integer,0)<>0) OR
     (p_payload->>'payment_type'='INSTALLMENT' AND coalesce((p_payload->>'installment_months')::integer,0) NOT BETWEEN 1 AND 120)
  THEN RAISE EXCEPTION 'INVALID_DEAL_DRAFT' USING ERRCODE='22023';END IF;
  SELECT c.currency INTO v_currency FROM public.units u JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id JOIN public.projects c ON c.id=b.project_id WHERE u.id=v_unit.id;
  v_base:=coalesce(v_unit.manual_total_price_minor,round(v_unit.area_m2_x100::numeric*v_unit.price_per_m2_minor/100)::bigint);
  INSERT INTO public.deals(lead_id,unit_id,responsible_user_id,status,payment_type,currency,base_price_minor,discount_minor,final_price_minor,down_payment_minor,installment_months,deal_date,created_at,updated_at,company_project_id,company_director_snapshot)
  VALUES((p_payload->>'lead_id')::integer,v_unit.id,p_actor,'DRAFT',coalesce(p_payload->>'payment_type','FULL'),v_currency,v_base,greatest(0,v_base-v_amount),v_amount,coalesce((p_payload->>'down_payment_minor')::integer,0),coalesce((p_payload->>'installment_months')::integer,0),v_date::text,now()::text,now()::text,p_project,
    jsonb_build_object('company_name',(SELECT name FROM public.crm_companies WHERE id=v_company.company_id),'director_name',v_company.director_name,'director_authority',v_company.director_authority,'captured_at',now())) RETURNING id INTO v_id;
  UPDATE public.units SET status='RESERVED',updated_at=now()::text WHERE id=v_unit.id;
  UPDATE public.leads SET status='NEGOTIATION',updated_at=now()::text WHERE id=(p_payload->>'lead_id')::integer;
  v_result:=jsonb_build_object('resource','deals','id',v_id,'status','DRAFT');
 ELSIF p_kind IN ('PAYMENT','EXPENSE') THEN
  v_cash:=(p_payload->>'cash_desk_id')::uuid;v_currency:=p_payload->>'currency';v_amount:=(p_payload->>'amount_minor')::bigint;v_rate:=(p_payload->>'exchange_rate')::numeric;
  IF v_cash IS NULL OR v_amount IS NULL OR v_amount<=0 OR v_amount>2147483647 OR (p_payload->>'amount_minor')::numeric<>v_amount OR v_currency IS NULL OR v_currency NOT IN ('USD','TJS') OR (v_rate IS NOT NULL AND (v_rate<=0 OR v_rate::text IN ('NaN','Infinity','-Infinity'))) OR (v_currency='TJS' AND v_rate IS NULL) THEN RAISE EXCEPTION 'INVALID_CASH_COMMAND' USING ERRCODE='22023';END IF;
  PERFORM 1 FROM public.company_project_cash_desks cp JOIN public.dictionaries d ON d.id=cp.cash_desk_id WHERE cp.cash_desk_id=v_cash AND cp.company_project_id=p_project AND d.type='CASH_DESK' AND d.is_active IS DISTINCT FROM false FOR UPDATE OF d;
  IF NOT FOUND THEN RAISE EXCEPTION 'CASH_DESK_OUTSIDE_PROJECT' USING ERRCODE='42501';END IF;
  -- A mapped cash desk must not already contain another project's active cash.
  IF EXISTS(
   SELECT 1 FROM (
    SELECT deal_id FROM public.payments WHERE cash_desk_id=v_cash AND status IN ('ACTIVE','POSTED') AND deal_id IS NOT NULL
    UNION ALL SELECT deal_id FROM public.expenses WHERE cash_desk_id=v_cash AND status='ACTIVE' AND deal_id IS NOT NULL
   ) cash WHERE NOT EXISTS(
    SELECT 1 FROM public.deals d JOIN public.units u ON u.id=d.unit_id JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id
    JOIN public.company_project_complexes cp ON cp.complex_id=b.project_id JOIN public.company_project_leads cl ON cl.lead_id=d.lead_id
    WHERE d.id=cash.deal_id AND cp.company_project_id=p_project AND cl.company_project_id=p_project
   )
  ) THEN RAISE EXCEPTION 'CASH_BOOK_REQUIRES_REVIEW' USING ERRCODE='23514';END IF;
  IF p_kind='PAYMENT' THEN
   PERFORM public.read_company_project_workspace(p_actor,p_project,'deals',p_payload->>'deal_id','',1);
   SELECT * INTO v_deal FROM public.deals WHERE id=(p_payload->>'deal_id')::integer FOR UPDATE;
   IF v_deal.status<>'SIGNED' OR v_deal.currency<>v_currency OR v_deal.payment_type NOT IN ('FULL','INSTALLMENT') THEN RAISE EXCEPTION 'PAYMENT_REQUIRES_SIGNED_SAME_CURRENCY_DEAL' USING ERRCODE='22023';END IF;
   IF EXISTS(SELECT 1 FROM public.payments WHERE deal_id=v_deal.id AND status IN ('ACTIVE','POSTED') AND currency IS DISTINCT FROM v_currency) THEN RAISE EXCEPTION 'MULTI_CURRENCY_REQUIRES_REVIEW' USING ERRCODE='22023';END IF;
   SELECT coalesce(sum(amount_minor),0) INTO v_paid FROM public.payments WHERE deal_id=v_deal.id AND status IN ('ACTIVE','POSTED');
   IF v_amount>v_deal.final_price_minor-v_paid THEN RAISE EXCEPTION 'PAYMENT_EXCEEDS_DEBT' USING ERRCODE='22023';END IF;
   v_doc:=public.create_income_payment_atomic(jsonb_build_object('deal_id',v_deal.id,'amount_minor',v_amount,'currency',v_currency,'payment_date',v_date,'method','CASH','settlement_method','CASH','operation_type','STANDARD','cash_desk_id',v_cash,'created_by_user_id',p_actor,'created_at',now(),'reference','ПКО-ПРОЕКТ-'||p_request::text,'comment',coalesce(p_payload->>'comment',''),'exchange_rate',v_rate,'amount_usd',CASE WHEN v_currency='USD' THEN v_amount/100.0 ELSE round(v_amount/100.0/v_rate,2) END,'amount_tjs',CASE WHEN v_currency='TJS' THEN v_amount/100.0 ELSE NULL END));
   v_id:=(v_doc->'payment'->>'id')::integer;
   IF v_id IS NULL THEN RAISE EXCEPTION 'PAYMENT_RESULT_MISSING';END IF;
   v_result:=jsonb_build_object('resource','payments','id',v_id,'status','ACTIVE');
  ELSE
   IF (p_payload->>'settlement_party_id' IS NULL)<>(p_payload->>'settlement_account' IS NULL) THEN RAISE EXCEPTION 'INCOMPLETE_SETTLEMENT' USING ERRCODE='22023';END IF;
   IF p_payload->>'settlement_party_id' IS NOT NULL THEN
    PERFORM 1 FROM public.company_project_parties cp JOIN public.construction_parties p ON p.id=cp.party_id WHERE cp.party_id=(p_payload->>'settlement_party_id')::uuid AND cp.company_project_id=p_project AND p.active FOR UPDATE OF p;
    IF NOT FOUND THEN RAISE EXCEPTION 'PARTY_OUTSIDE_PROJECT' USING ERRCODE='42501';END IF;
    v_doc:=public.create_expense_with_settlement(p_payload||jsonb_build_object('amount',v_amount/100.0,'expense_date',v_date,'idempotency_key','workspace:'||p_request::text,'auto_convert',false),p_actor);v_id:=(v_doc->>'id')::integer;
   ELSE
    v_doc:=public.create_atomic_expense(v_cash,v_amount,v_currency::varchar,v_date,(p_payload->>'category')::varchar,(p_payload->>'recipient')::varchar,p_payload->>'description',p_actor,'CASH'::varchar,v_rate,CASE WHEN v_currency='USD' THEN v_amount/100.0 ELSE round(v_amount/100.0/v_rate,2) END,CASE WHEN v_currency='TJS' THEN v_amount/100.0 ELSE NULL END,('workspace:'||p_request::text)::varchar);v_id:=(v_doc->>'expense_id')::integer;
   END IF;
   IF v_id IS NULL THEN RAISE EXCEPTION 'EXPENSE_RESULT_MISSING';END IF;
   v_result:=jsonb_build_object('resource','expenses','id',v_id,'status','ACTIVE');
  END IF;
 ELSE
  IF p_payload->>'kind' IS NULL OR p_payload->>'kind' NOT IN ('RECEIPT','ISSUE','TRANSFER','RETURN_STOCK','WRITE_OFF') OR p_payload->>'currency' IS NULL OR p_payload->>'currency' NOT IN ('USD','TJS') OR jsonb_typeof(p_payload->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'lines') NOT BETWEEN 1 AND 200 OR length(btrim(coalesce(p_payload->>'basis',''))) NOT BETWEEN 1 AND 3000 THEN RAISE EXCEPTION 'INVALID_STOCK_COMMAND' USING ERRCODE='22023';END IF;
  PERFORM 1 FROM public.company_project_warehouses cp JOIN public.construction_warehouses w ON w.id=cp.warehouse_id WHERE cp.warehouse_id=(p_payload->>'warehouse_id')::uuid AND cp.company_project_id=p_project AND w.active FOR UPDATE OF w;
  IF NOT FOUND THEN RAISE EXCEPTION 'WAREHOUSE_OUTSIDE_PROJECT' USING ERRCODE='42501';END IF;
  IF p_payload->>'destination_id' IS NOT NULL THEN
   PERFORM 1 FROM public.company_project_warehouses cp JOIN public.construction_warehouses w ON w.id=cp.warehouse_id WHERE cp.warehouse_id=(p_payload->>'destination_id')::uuid AND cp.company_project_id=p_project AND w.active FOR UPDATE OF w;
   IF NOT FOUND THEN RAISE EXCEPTION 'DESTINATION_OUTSIDE_PROJECT' USING ERRCODE='42501';END IF;
  END IF;
  IF p_payload->>'party_id' IS NOT NULL THEN
   PERFORM 1 FROM public.company_project_parties cp JOIN public.construction_parties p ON p.id=cp.party_id WHERE cp.party_id=(p_payload->>'party_id')::uuid AND cp.company_project_id=p_project AND p.active FOR UPDATE OF p;
   IF NOT FOUND THEN RAISE EXCEPTION 'PARTY_OUTSIDE_PROJECT' USING ERRCODE='42501';END IF;
  END IF;
  IF p_payload->>'complex_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.company_project_complexes WHERE complex_id=(p_payload->>'complex_id')::integer AND company_project_id=p_project) THEN RAISE EXCEPTION 'COMPLEX_OUTSIDE_PROJECT' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'lines') l WHERE jsonb_typeof(l) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(l) k WHERE k NOT IN ('material_id','quantity','value'))) THEN RAISE EXCEPTION 'UNSUPPORTED_STOCK_LINE' USING ERRCODE='22023';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'lines') l WHERE
    jsonb_typeof(l->'quantity') IS DISTINCT FROM 'number' OR (l->>'quantity')::numeric<=0 OR (l->>'quantity')::numeric>1000000000 OR (l->>'quantity')::numeric<>round((l->>'quantity')::numeric,4) OR
    (p_payload->>'kind' IN ('RECEIPT','RETURN_STOCK') AND (jsonb_typeof(l->'value') IS DISTINCT FROM 'number' OR (l->>'value')::numeric<0 OR (l->>'value')::numeric>1000000000000 OR (l->>'value')::numeric<>round((l->>'value')::numeric,2)))) THEN
   RAISE EXCEPTION 'INVALID_STOCK_LINE_AMOUNT' USING ERRCODE='22023';END IF;
  INSERT INTO public.construction_documents(kind,doc_date,currency,warehouse_id,destination_id,party_id,project_id,work_type,basis,lines,created_by)
  VALUES(p_payload->>'kind',v_date,p_payload->>'currency',(p_payload->>'warehouse_id')::uuid,(p_payload->>'destination_id')::uuid,(p_payload->>'party_id')::uuid,(p_payload->>'complex_id')::integer,p_payload->>'work_type',p_payload->>'basis',p_payload->'lines',p_actor) RETURNING id INTO v_stock;
  v_doc:=public.construction_post(v_stock,p_actor);
  IF v_doc->>'status' IS DISTINCT FROM 'POSTED' THEN RAISE EXCEPTION 'STOCK_POST_FAILED';END IF;
  v_result:=jsonb_build_object('resource','stock_documents','id',v_stock,'status','POSTED');
 END IF;
 INSERT INTO public.company_project_commands(request_id,company_project_id,actor_id,kind,payload,result) VALUES(p_request,p_project,p_actor,p_kind,p_payload,v_result);
 RETURN v_result||jsonb_build_object('idempotent',false);
END $fn$;
REVOKE ALL ON FUNCTION public.execute_company_project_command(integer,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.execute_company_project_command(integer,uuid,uuid,text,jsonb) TO service_role;
