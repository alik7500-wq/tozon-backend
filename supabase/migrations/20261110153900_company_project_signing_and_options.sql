ALTER TABLE public.company_workspace_access DROP CONSTRAINT company_workspace_access_write_sections_check;
ALTER TABLE public.company_workspace_access ADD CONSTRAINT company_workspace_write_sections_allowed CHECK(write_sections <@ ARRAY['deals.write','contracts.sign','finance.payments.write','finance.expenses.write','construction.stock.write']::text[]);
ALTER TABLE public.company_project_commands DROP CONSTRAINT company_project_commands_kind_check;
ALTER TABLE public.company_project_commands ADD CONSTRAINT company_project_commands_kind_allowed CHECK(kind IN ('DEAL_DRAFT','SIGN_DEAL','PAYMENT','EXPENSE','STOCK_POST'));
ALTER FUNCTION public.execute_company_project_command(integer,uuid,uuid,text,jsonb) RENAME TO execute_company_project_base_command;
REVOKE ALL ON FUNCTION public.execute_company_project_base_command(integer,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.execute_company_project_command(p_actor integer,p_project uuid,p_request uuid,p_kind text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE
 d public.deals;u public.units;cp public.company_projects;s public.discount_schemes;h public.company_project_commands;
 v_complex integer;company_name text;rule jsonb;key jsonb;matches integer;today date:=(now() AT TIME ZONE 'Asia/Dushanbe')::date;
 base bigint;final bigint;down bigint;balance bigint;price bigint;months integer;max_months integer:=120;min_percent numeric:=0;
 first_date date;limit_percent numeric:=100;snapshot jsonb;result jsonb;first_amount bigint;extra bigint;
BEGIN
 IF p_kind IS DISTINCT FROM 'SIGN_DEAL' THEN RETURN public.execute_company_project_base_command(p_actor,p_project,p_request,p_kind,p_payload);END IF;
 IF p_request IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR
  EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('deal_id','expected_updated_at','scheme_id','scheme_updated_at','rule_key','down_payment_minor','installment_months','first_payment_date')) THEN RAISE EXCEPTION 'INVALID_SIGN_COMMAND' USING ERRCODE='22023';END IF;
 PERFORM 1 FROM public.users x JOIN public.company_workspace_users w ON w.user_id=x.id WHERE x.id=p_actor AND x.is_active=1 AND w.enabled AND coalesce(x.permissions,'[]'::jsonb)?'company.project-only' FOR SHARE OF x,w;
 IF NOT FOUND THEN RAISE EXCEPTION 'WORKSPACE_ACCESS_DENIED' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.company_workspace_access WHERE user_id=p_actor AND company_project_id=p_project AND enabled AND 'contracts.sign'=ANY(write_sections) AND 'deals.view'=ANY(sections) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'WORKSPACE_SIGN_DENIED' USING ERRCODE='42501';END IF;
 PERFORM public.read_company_project_workspace(p_actor,p_project,'deals',p_payload->>'deal_id','',1);
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('workspace-command:'||p_request::text,0));
 SELECT * INTO h FROM public.company_project_commands WHERE request_id=p_request;
 IF FOUND THEN
  IF h.actor_id<>p_actor OR h.company_project_id<>p_project OR h.kind<>p_kind OR h.payload<>p_payload THEN RAISE EXCEPTION 'WORKSPACE_REQUEST_REUSED' USING ERRCODE='23505';END IF;
  RETURN h.result||jsonb_build_object('idempotent',true);
 END IF;
 SELECT * INTO d FROM public.deals WHERE id=(p_payload->>'deal_id')::integer AND company_project_id=p_project FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SCOPED_DRAFT_REQUIRED' USING ERRCODE='42501';END IF;
 IF d.status<>'DRAFT' OR p_payload->>'expected_updated_at' IS NULL OR p_payload->>'expected_updated_at' IS DISTINCT FROM d.updated_at THEN RAISE EXCEPTION 'STALE_DEAL_DRAFT' USING ERRCODE='40001';END IF;
 PERFORM 1 FROM public.company_project_complexes WHERE company_project_id=p_project FOR SHARE;
 PERFORM 1 FROM public.company_project_leads WHERE company_project_id=p_project FOR SHARE;
 SELECT * INTO u FROM public.units WHERE id=d.unit_id AND archived_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'UNIT_UNAVAILABLE' USING ERRCODE='23505';END IF;
 SELECT b.project_id INTO v_complex FROM public.floors f JOIN public.sections sec ON sec.id=f.section_id JOIN public.buildings b ON b.id=sec.building_id JOIN public.projects c ON c.id=b.project_id WHERE f.id=u.floor_id AND f.archived_at IS NULL AND sec.archived_at IS NULL AND b.archived_at IS NULL AND c.archived_at IS NULL FOR SHARE OF f,sec,b,c;
 IF u.status<>'RESERVED' OR EXISTS(SELECT 1 FROM public.deals WHERE unit_id=u.id AND id<>d.id AND status IN ('DRAFT','RESERVED','SIGNED')) THEN RAISE EXCEPTION 'UNIT_UNAVAILABLE' USING ERRCODE='23505';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.company_project_complexes m WHERE m.complex_id=v_complex AND m.company_project_id=p_project) OR NOT EXISTS(SELECT 1 FROM public.company_project_leads WHERE lead_id=d.lead_id AND company_project_id=p_project) THEN RAISE EXCEPTION 'PROJECT_LINK_CHANGED' USING ERRCODE='42501';END IF;
 IF d.currency<>'USD' THEN RAISE EXCEPTION 'SIGNING_USD_ONLY' USING ERRCODE='22023';END IF;
 PERFORM 1 FROM public.leads WHERE id=d.lead_id AND archived_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'BUYER_UNAVAILABLE' USING ERRCODE='23514';END IF;
 SELECT * INTO STRICT cp FROM public.company_projects WHERE id=p_project FOR SHARE;
 SELECT name INTO STRICT company_name FROM public.crm_companies WHERE id=cp.company_id;
 IF btrim(cp.director_name)='' OR btrim(cp.director_authority)='' THEN RAISE EXCEPTION 'PROJECT_SIGNER_NOT_CONFIGURED' USING ERRCODE='23514';END IF;
 base:=CASE WHEN u.unit_kind<>'APARTMENT' AND u.manual_total_price_minor IS NOT NULL THEN u.manual_total_price_minor ELSE round(u.area_m2_x100::numeric*u.price_per_m2_minor/100)::bigint END;final:=base;
 IF p_payload->>'scheme_id' IS NOT NULL THEN
  SELECT * INTO s FROM public.discount_schemes WHERE id=(p_payload->>'scheme_id')::uuid AND project_id=v_complex FOR SHARE;
  IF NOT FOUND OR NOT s.is_active OR u.unit_kind<>'APARTMENT' OR s.starts_on::date>today OR s.ends_on::date<today THEN RAISE EXCEPTION 'SCHEME_UNAVAILABLE' USING ERRCODE='23514';END IF;
  IF p_payload->>'scheme_updated_at' IS NULL OR (p_payload->>'scheme_updated_at')::timestamptz IS DISTINCT FROM s.updated_at::timestamptz THEN RAISE EXCEPTION 'STALE_DISCOUNT_SCHEME' USING ERRCODE='40001';END IF;
  key:=(p_payload->>'rule_key')::jsonb;
  SELECT count(*),jsonb_agg(r)->0 INTO matches,rule FROM jsonb_array_elements(s.rules) r WHERE jsonb_build_array((r->>'payment_percent')::numeric,(r->>'price_per_m2')::numeric,coalesce((r->>'discount_percent')::numeric,0),(r->>'months')::integer)=key;
  IF matches<>1 THEN RAISE EXCEPTION 'EXACT_OFFER_REQUIRED' USING ERRCODE='22023';END IF;
  min_percent:=(rule->>'payment_percent')::numeric;max_months:=(rule->>'months')::integer;
  IF min_percent IS NULL OR min_percent NOT BETWEEN 0 AND 100 OR max_months IS NULL OR max_months NOT BETWEEN 0 AND 120 THEN RAISE EXCEPTION 'INVALID_OFFER_TERMS' USING ERRCODE='23514';END IF;
  final:=CASE WHEN rule->>'price_per_m2' IS NOT NULL THEN round(u.area_m2_x100::numeric*round((rule->>'price_per_m2')::numeric*100)/100)::bigint ELSE base-round(base*(rule->>'discount_percent')::numeric/100)::bigint END;
  snapshot:=rule||jsonb_build_object('scheme_id',s.id,'scheme_name',s.name,'scheme_updated_at',s.updated_at,'rule_key',p_payload->>'rule_key');
 ELSIF p_payload->>'rule_key' IS NOT NULL OR p_payload->>'scheme_updated_at' IS NOT NULL THEN RAISE EXCEPTION 'SCHEME_REQUIRED' USING ERRCODE='22023';END IF;
 SELECT coalesce((data->>'max_discount_percent')::numeric,100) INTO limit_percent FROM public.crm_document_settings WHERE id=1;
 limit_percent:=coalesce(limit_percent,100);
 IF base IS NULL OR base<=0 OR final IS NULL OR final<=0 OR final>base OR final>2147483647 OR (base-final)::numeric*100/base>limit_percent THEN RAISE EXCEPTION 'INVALID_SIGN_PRICE' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(p_payload->'down_payment_minor') IS DISTINCT FROM 'number' OR jsonb_typeof(p_payload->'installment_months') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'INVALID_SIGN_TERMS' USING ERRCODE='22023';END IF;
 down:=(p_payload->>'down_payment_minor')::bigint;months:=(p_payload->>'installment_months')::integer;balance:=final-down;
 IF down<round(final*min_percent/100) OR down>final OR down<0 OR (p_payload->>'down_payment_minor')::numeric<>down OR (p_payload->>'installment_months')::numeric<>months OR (balance=0 AND months<>0) OR (balance>0 AND (months<1 OR months>max_months OR months>balance)) THEN RAISE EXCEPTION 'INVALID_SIGN_TERMS' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.payments WHERE deal_id=d.id AND status IN ('ACTIVE','POSTED')) OR EXISTS(SELECT 1 FROM public.deal_payment_schedules WHERE deal_id=d.id) THEN RAISE EXCEPTION 'DRAFT_ALREADY_HAS_FINANCIAL_MOVEMENTS' USING ERRCODE='23514';END IF;
 IF balance>0 THEN
  first_date:=coalesce((p_payload->>'first_payment_date')::date,CASE WHEN down=0 THEN d.deal_date::date ELSE (d.deal_date::date+interval '1 month')::date END);
  IF first_date<d.deal_date::date THEN RAISE EXCEPTION 'INVALID_FIRST_PAYMENT_DATE' USING ERRCODE='22023';END IF;
  first_amount:=balance/months;extra:=balance%months;
  INSERT INTO public.deal_payment_schedules(deal_id,payment_number,due_date,amount_minor,paid_amount_minor,status,created_at,updated_at)
   SELECT d.id,i,(first_date+((i-1)||' month')::interval)::date::text,(first_amount+CASE WHEN i<=extra THEN 1 ELSE 0 END)::integer,0,'UPCOMING',now(),now() FROM generate_series(1,months) i;
 END IF;
 snapshot:=CASE WHEN snapshot IS NULL THEN NULL ELSE snapshot||jsonb_build_object('base_price_minor',base,'discount_minor',base-final,'final_price_minor',final,'agreed_down_payment_minor',down,'agreed_installment_months',months) END;
 UPDATE public.deals SET status='SIGNED',payment_type=CASE WHEN balance=0 THEN 'FULL' ELSE 'INSTALLMENT' END,base_price_minor=base,discount_minor=base-final,final_price_minor=final,down_payment_minor=down,installment_months=months,first_payment_date=first_date::text,installment_interval_months=1,discount_snapshot=snapshot,deal_price_per_m2_minor=CASE WHEN u.area_m2_x100>0 THEN round(final::numeric*100/u.area_m2_x100)::bigint ELSE 0 END,
  signed_at=now()::text,updated_at=now()::text,company_director_snapshot=jsonb_build_object('company_name',company_name,'director_name',cp.director_name,'director_authority',cp.director_authority,'captured_at',now()) WHERE id=d.id;
 UPDATE public.units SET status='SOLD',updated_at=now()::text WHERE id=u.id;
 UPDATE public.leads SET status='WON',updated_at=now()::text WHERE id=d.lead_id;
 result:=jsonb_build_object('resource','deals','id',d.id,'status','SIGNED','final_price_minor',final,'down_payment_minor',down,'installment_months',months);
 INSERT INTO public.company_project_commands(request_id,company_project_id,actor_id,kind,payload,result) VALUES(p_request,p_project,p_actor,p_kind,p_payload,result);
 RETURN result||jsonb_build_object('idempotent',false);
END $fn$;
REVOKE ALL ON FUNCTION public.execute_company_project_command(integer,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.execute_company_project_command(integer,uuid,uuid,text,jsonb) TO service_role;

CREATE FUNCTION public.company_project_operation_options(p_actor integer,p_project uuid,p_kind text DEFAULT 'context',p_after text DEFAULT '',p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE a public.company_workspace_access;cp public.company_projects;commands text[]:='{}';query text;common text;rows jsonb;allowed boolean;
BEGIN
 PERFORM public.read_company_project_workspace(p_actor,NULL,'projects',NULL,'',1);
 SELECT * INTO a FROM public.company_workspace_access WHERE user_id=p_actor AND company_project_id=p_project AND enabled;
 IF NOT FOUND THEN RAISE EXCEPTION 'WORKSPACE_ACCESS_DENIED' USING ERRCODE='42501';END IF;
 IF 'deals.write'=ANY(a.write_sections) AND 'deals.view'=ANY(a.sections) THEN commands:=array_append(commands,'DEAL_DRAFT');END IF;
 IF 'contracts.sign'=ANY(a.write_sections) AND 'deals.view'=ANY(a.sections) THEN commands:=array_append(commands,'SIGN_DEAL');END IF;
 IF 'finance.payments.write'=ANY(a.write_sections) AND 'finance.payments'=ANY(a.sections) AND 'deals.view'=ANY(a.sections) THEN commands:=array_append(commands,'PAYMENT');END IF;
 IF 'finance.expenses.write'=ANY(a.write_sections) AND 'finance.expenses'=ANY(a.sections) THEN commands:=array_append(commands,'EXPENSE');END IF;
 IF 'construction.stock.write'=ANY(a.write_sections) AND 'construction.stock'=ANY(a.sections) THEN commands:=array_append(commands,'STOCK_POST');END IF;
 IF p_kind='context' THEN
  SELECT * INTO STRICT cp FROM public.company_projects WHERE id=p_project;
  RETURN jsonb_build_object('commands',to_jsonb(commands),'project_id',p_project,'signer_configured',btrim(cp.director_name)<>'' AND btrim(cp.director_authority)<>'','signer_name',CASE WHEN 'SIGN_DEAL'=ANY(commands) THEN cp.director_name ELSE NULL END);
 END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR length(coalesce(p_after,''))>40 THEN RAISE EXCEPTION 'INVALID_OPTIONS_PAGE' USING ERRCODE='22023';END IF;
 allowed:=CASE p_kind
  WHEN 'units' THEN 'DEAL_DRAFT'=ANY(commands)
  WHEN 'leads' THEN 'DEAL_DRAFT'=ANY(commands)
  WHEN 'deals' THEN commands&&ARRAY['SIGN_DEAL','PAYMENT']
  WHEN 'cash_desks' THEN commands&&ARRAY['PAYMENT','EXPENSE']
  WHEN 'parties' THEN commands&&ARRAY['EXPENSE','STOCK_POST']
  WHEN 'warehouses' THEN 'STOCK_POST'=ANY(commands)
  WHEN 'materials' THEN 'STOCK_POST'=ANY(commands)
  WHEN 'complexes' THEN 'STOCK_POST'=ANY(commands)
  WHEN 'schemes' THEN 'SIGN_DEAL'=ANY(commands)
  ELSE false END;
 IF NOT allowed THEN RAISE EXCEPTION 'WORKSPACE_OPTIONS_DENIED' USING ERRCODE='42501';END IF;
 common:=$q$WITH own_units AS (
  SELECT u.id,u.unit_number,u.unit_kind,u.area_m2_x100,u.price_per_m2_minor,u.manual_total_price_minor,u.status,c.id AS project_id,c.name AS complex_name,c.currency
  FROM public.units u JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id JOIN public.projects c ON c.id=b.project_id JOIN public.company_project_complexes cp ON cp.complex_id=c.id
  WHERE cp.company_project_id=$1 AND u.archived_at IS NULL AND f.archived_at IS NULL AND s.archived_at IS NULL AND b.archived_at IS NULL AND c.archived_at IS NULL
 ), records AS ($q$;
 query:=CASE p_kind
  WHEN 'units' THEN 'SELECT u.id::text AS id,to_jsonb(u) AS item FROM own_units u WHERE status=''AVAILABLE'''
  WHEN 'leads' THEN 'SELECT l.id::text AS id,jsonb_build_object(''id'',l.id,''name'',l.full_name) AS item FROM public.leads l JOIN public.company_project_leads cp ON cp.lead_id=l.id WHERE cp.company_project_id=$1 AND l.archived_at IS NULL'
  WHEN 'deals' THEN 'SELECT d.id::text AS id,jsonb_build_object(''id'',d.id,''name'',coalesce(d.contract_number,''Черновик'')||'' · ''||l.full_name||'' · №''||u.unit_number,''status'',d.status,''updated_at'',d.updated_at,''deal_date'',d.deal_date,''final_price_minor'',d.final_price_minor,''currency'',d.currency,''unit'',to_jsonb(u)) AS item FROM public.deals d JOIN own_units u ON u.id=d.unit_id JOIN public.company_project_leads cp ON cp.lead_id=d.lead_id AND cp.company_project_id=$1 JOIN public.leads l ON l.id=d.lead_id WHERE ((d.status=''DRAFT'' AND d.company_project_id=$1) OR (d.status=''SIGNED'' AND (d.company_project_id IS NULL OR d.company_project_id=$1)))'
  WHEN 'cash_desks' THEN 'SELECT d.id::text AS id,jsonb_build_object(''id'',d.id,''name'',d.name) AS item FROM public.dictionaries d JOIN public.company_project_cash_desks cp ON cp.cash_desk_id=d.id WHERE cp.company_project_id=$1 AND d.type=''CASH_DESK'' AND d.is_active IS DISTINCT FROM false'
  WHEN 'parties' THEN 'SELECT p.id::text AS id,jsonb_build_object(''id'',p.id,''name'',p.name,''kind'',p.kind) AS item FROM public.construction_parties p JOIN public.company_project_parties cp ON cp.party_id=p.id WHERE cp.company_project_id=$1 AND p.active'
  WHEN 'warehouses' THEN 'SELECT w.id::text AS id,jsonb_build_object(''id'',w.id,''name'',w.name) AS item FROM public.construction_warehouses w JOIN public.company_project_warehouses cp ON cp.warehouse_id=w.id WHERE cp.company_project_id=$1 AND w.active'
  WHEN 'materials' THEN 'SELECT m.id::text AS id,jsonb_build_object(''id'',m.id,''name'',m.name,''unit'',m.unit) AS item FROM public.construction_materials m WHERE m.active'
  WHEN 'complexes' THEN 'SELECT c.id::text AS id,jsonb_build_object(''id'',c.id,''name'',c.name) AS item FROM public.projects c JOIN public.company_project_complexes cp ON cp.complex_id=c.id WHERE cp.company_project_id=$1 AND c.archived_at IS NULL'
  WHEN 'schemes' THEN 'SELECT s.id::text AS id,jsonb_build_object(''id'',s.id,''name'',s.name,''project_id'',s.project_id,''rules'',s.rules,''updated_at'',s.updated_at) AS item FROM public.discount_schemes s JOIN public.company_project_complexes cp ON cp.complex_id=s.project_id WHERE cp.company_project_id=$1 AND s.is_active AND (s.starts_on IS NULL OR s.starts_on::date<=(now() AT TIME ZONE ''Asia/Dushanbe'')::date) AND (s.ends_on IS NULL OR s.ends_on::date>=(now() AT TIME ZONE ''Asia/Dushanbe'')::date)'
 END;
 EXECUTE common||query||') SELECT coalesce(jsonb_agg(item ORDER BY id),''[]''::jsonb) FROM (SELECT id,item FROM records WHERE id>$2 ORDER BY id LIMIT $3) p' INTO rows USING p_project,coalesce(p_after,''),p_limit+1;
 RETURN jsonb_build_object('records',CASE WHEN jsonb_array_length(rows)>p_limit THEN rows-p_limit ELSE rows END,'has_more',jsonb_array_length(rows)>p_limit,'project_id',p_project);
END $fn$;
REVOKE ALL ON FUNCTION public.company_project_operation_options(integer,uuid,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.company_project_operation_options(integer,uuid,text,text,integer) TO service_role;
