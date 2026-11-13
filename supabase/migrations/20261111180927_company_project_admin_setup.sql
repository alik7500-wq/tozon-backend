-- Pilot administration: explicit scoped identities, grants and reviewed demo ownership.
ALTER TABLE public.company_workspace_access ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
CREATE TABLE public.company_project_admin_commands(
 request_id uuid PRIMARY KEY,company_project_id uuid NOT NULL REFERENCES public.company_projects(id),actor_id integer NOT NULL REFERENCES public.users(id),kind text NOT NULL,payload jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.company_project_admin_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_project_admin_commands FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.company_project_admin_commands TO service_role;

CREATE FUNCTION public.read_company_project_setup(p_actor integer,p_project uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
 PERFORM tozon_internal.authorize_reminder_admin(p_actor);
 IF NOT EXISTS(SELECT 1 FROM public.company_projects WHERE id=p_project) THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND' USING ERRCODE='P0002';END IF;
 RETURN jsonb_build_object('revision',(SELECT revision FROM public.company_projects WHERE id=p_project),
 'members',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',u.id,'name',u.name,'active',u.is_active=1,'project_only',coalesce(u.permissions,'[]'::jsonb)?'company.project-only','project_role',m.project_role,'revision',coalesce(a.revision,0),'enabled',coalesce(a.enabled,false) AND coalesce(w.enabled,false),'sections',coalesce(a.sections,'{}'::text[]),'write_sections',coalesce(a.write_sections,'{}'::text[])) ORDER BY u.id),'[]'::jsonb) FROM public.company_project_memberships m JOIN public.users u ON u.id=m.user_id LEFT JOIN public.company_workspace_users w ON w.user_id=u.id LEFT JOIN public.company_workspace_access a ON a.user_id=u.id AND a.company_project_id=m.company_project_id WHERE m.company_project_id=p_project),
 'cash_desks',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'project_id',cp.company_project_id) ORDER BY d.name,d.id),'[]'::jsonb) FROM public.dictionaries d LEFT JOIN public.company_project_cash_desks cp ON cp.cash_desk_id=d.id WHERE d.type='CASH_DESK' AND d.is_active IS DISTINCT FROM false),
 'warehouses',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',w.id,'name',w.name,'project_id',cp.company_project_id) ORDER BY w.name,w.id),'[]'::jsonb) FROM public.construction_warehouses w LEFT JOIN public.company_project_warehouses cp ON cp.warehouse_id=w.id WHERE w.active));
END $fn$;

CREATE FUNCTION tozon_internal.project_demo_binding(p_project uuid,p_deal integer) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE d public.deals;c record;lead_owner uuid;reasons text[]:='{}';
BEGIN
 SELECT * INTO d FROM public.deals WHERE id=p_deal;
 SELECT p.id,p.code,cp.company_project_id,u.unit_number INTO c FROM public.units u JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id JOIN public.projects p ON p.id=b.project_id LEFT JOIN public.company_project_complexes cp ON cp.complex_id=p.id WHERE u.id=d.unit_id AND u.archived_at IS NULL AND f.archived_at IS NULL AND s.archived_at IS NULL AND b.archived_at IS NULL AND p.archived_at IS NULL;
 IF d.id IS NULL OR c.company_project_id IS DISTINCT FROM p_project THEN RAISE EXCEPTION 'PROJECT_DEAL_NOT_FOUND' USING ERRCODE='P0002';END IF;
 IF c.code<>'DEMO-001' THEN reasons:=array_append(reasons,'Только демонстрационный ЖК; рабочий перенос требует отдельной сверки');END IF;
 IF d.company_project_id IS NOT NULL THEN reasons:=array_append(reasons,'Договор уже имеет проект');END IF;
 IF coalesce(d.status,'') NOT IN ('DRAFT','SIGNED') OR d.company_closure_snapshot IS NOT NULL OR coalesce(d.currency,'')<>'USD' OR coalesce(d.payment_type,'') NOT IN ('FULL','INSTALLMENT') THEN reasons:=array_append(reasons,'Статус, валюта или форма оплаты требуют отдельного разбора');END IF;
 IF EXISTS(SELECT 1 FROM public.payments WHERE deal_id=d.id) OR EXISTS(SELECT 1 FROM public.expenses WHERE deal_id=d.id) OR EXISTS(SELECT 1 FROM public.deal_payment_schedules WHERE deal_id=d.id AND coalesce(paid_amount_minor,0)<>0) OR EXISTS(SELECT 1 FROM jsonb_each(to_jsonb(d)) kv WHERE kv.key~'(barter|vehicle)' AND kv.value NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb,'[]'::jsonb,'{}'::jsonb)) THEN reasons:=array_append(reasons,'Есть движения, оплаченный график или бартер: нужен отдельный перенос');END IF;
 SELECT company_project_id INTO lead_owner FROM public.company_project_leads WHERE lead_id=d.lead_id;
 IF lead_owner IS NOT NULL AND lead_owner<>p_project THEN reasons:=array_append(reasons,'Клиент принадлежит другому проекту');END IF;
 IF EXISTS(SELECT 1 FROM public.deals x LEFT JOIN public.units u ON u.id=x.unit_id LEFT JOIN public.floors f ON f.id=u.floor_id LEFT JOIN public.sections s ON s.id=f.section_id LEFT JOIN public.buildings b ON b.id=s.building_id LEFT JOIN public.company_project_complexes cp ON cp.complex_id=b.project_id WHERE x.lead_id=d.lead_id AND x.id<>d.id AND (cp.company_project_id IS DISTINCT FROM p_project OR (x.company_project_id IS NOT NULL AND x.company_project_id<>p_project))) THEN reasons:=array_append(reasons,'У клиента есть договор вне проекта');END IF;
 RETURN jsonb_build_object('id',d.id,'contract_number',d.contract_number,'status',d.status,'updated_at',d.updated_at,'client_name',(SELECT full_name FROM public.leads WHERE id=d.lead_id),'unit_number',c.unit_number,'eligible',cardinality(reasons)=0,'reasons',reasons,'signer_snapshot_present',d.company_director_snapshot IS NOT NULL);
END $fn$;

CREATE FUNCTION public.read_company_project_unbound_deals(p_actor integer,p_project uuid,p_after integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE ids integer[];items jsonb;
BEGIN
 PERFORM tozon_internal.authorize_reminder_admin(p_actor);
 IF NOT EXISTS(SELECT 1 FROM public.company_projects WHERE id=p_project) THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND' USING ERRCODE='P0002';END IF;
 SELECT array_agg(id ORDER BY id) INTO ids FROM (SELECT d.id FROM public.deals d JOIN public.units u ON u.id=d.unit_id JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id JOIN public.company_project_complexes cp ON cp.complex_id=b.project_id WHERE cp.company_project_id=p_project AND d.company_project_id IS NULL AND d.id>coalesce(p_after,0) ORDER BY d.id LIMIT 51) q;
 SELECT coalesce(jsonb_agg(tozon_internal.project_demo_binding(p_project,id) ORDER BY id),'[]'::jsonb) INTO items FROM unnest(ids[1:50]) id;
 RETURN jsonb_build_object('records',items,'has_more',coalesce(cardinality(ids)>50,false));
END $fn$;

CREATE FUNCTION public.execute_company_project_admin(p_actor integer,p_project uuid,p_request uuid,p_kind text,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE previous public.company_project_admin_commands;cp public.company_projects;u public.users;a public.company_workspace_access;result jsonb;new_user_id integer;resource_id uuid;owner uuid;target text;sections text[];writes text[];dep record;d public.deals;candidate jsonb;
BEGIN
 PERFORM tozon_internal.authorize_reminder_admin(p_actor);
 IF p_request IS NULL OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' THEN RAISE EXCEPTION 'INVALID_ADMIN_COMMAND' USING ERRCODE='22023';END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('project-admin:'||p_request::text,0));
 SELECT * INTO previous FROM public.company_project_admin_commands WHERE request_id=p_request;
 IF FOUND THEN
  IF previous.actor_id<>p_actor OR previous.company_project_id<>p_project OR previous.kind<>p_kind OR previous.payload<>(p_payload-'password_hash') THEN RAISE EXCEPTION 'ADMIN_REQUEST_REUSED' USING ERRCODE='23505';END IF;
  RETURN previous.result||jsonb_build_object('idempotent',true);
 END IF;
 SELECT * INTO cp FROM public.company_projects WHERE id=p_project FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND' USING ERRCODE='P0002';END IF;
 IF (p_payload->>'project_revision')::integer IS DISTINCT FROM cp.revision THEN RAISE EXCEPTION 'STALE_PROJECT_SETUP' USING ERRCODE='40001';END IF;
 CASE p_kind
 WHEN 'CREATE_ACCOUNT' THEN
  IF length(btrim(p_payload->>'name')) NOT BETWEEN 1 AND 200 OR length(p_payload->>'email') NOT BETWEEN 3 AND 254 OR (p_payload->>'email')<>lower(p_payload->>'email') OR (p_payload->>'password_hash')!~'^\$2[aby]\$12\$[./A-Za-z0-9]{53}$' OR (p_payload->>'password_fingerprint')!~'^[a-f0-9]{64}$' OR (p_payload->>'project_role') NOT IN ('PARTNER','DIRECTOR','ACCOUNTANT','MANAGER','CASHIER','WAREHOUSE') THEN RAISE EXCEPTION 'INVALID_PROJECT_ACCOUNT' USING ERRCODE='22023';END IF;
  -- Legacy users.id is not a sequence: serialize all inserts, not just this API.
  LOCK TABLE public.users IN SHARE ROW EXCLUSIVE MODE;
  SELECT coalesce(max(id),0)+1 INTO new_user_id FROM public.users;
  INSERT INTO public.users(id,name,email,password_hash,role,is_active,permissions,created_at,updated_at) VALUES(new_user_id,btrim(p_payload->>'name'),p_payload->>'email',p_payload->>'password_hash','SALES_MANAGER',1,'["company.project-only"]',now()::text,now()::text);
  INSERT INTO public.company_project_memberships(company_project_id,user_id,project_role) VALUES(p_project,new_user_id,p_payload->>'project_role');
  INSERT INTO public.company_workspace_users(user_id,enabled) VALUES(new_user_id,false);
  INSERT INTO public.company_workspace_access(user_id,company_project_id) VALUES(new_user_id,p_project);
  UPDATE public.company_projects SET revision=revision+1,updated_at=now() WHERE id=p_project;
  result:=jsonb_build_object('id',new_user_id,'enabled',false);
 WHEN 'SET_ACCESS' THEN
  SELECT * INTO u FROM public.users WHERE id=(p_payload->>'user_id')::integer FOR UPDATE;
  IF u.id IS NULL OR u.id=p_actor OR NOT(coalesce(u.permissions,'[]'::jsonb)?'company.project-only') OR NOT EXISTS(SELECT 1 FROM public.company_project_memberships WHERE company_project_id=p_project AND user_id=u.id) THEN RAISE EXCEPTION 'DEDICATED_PROJECT_ACCOUNT_REQUIRED' USING ERRCODE='42501';END IF;
  SELECT * INTO a FROM public.company_workspace_access WHERE user_id=u.id AND company_project_id=p_project FOR UPDATE;
  IF coalesce(a.revision,0) IS DISTINCT FROM (p_payload->>'revision')::integer THEN RAISE EXCEPTION 'STALE_PROJECT_ACCESS' USING ERRCODE='40001';END IF;
  SELECT coalesce(array_agg(x),'{}') INTO sections FROM jsonb_array_elements_text(p_payload->'sections') x;
  SELECT coalesce(array_agg(x),'{}') INTO writes FROM jsonb_array_elements_text(p_payload->'write_sections') x;
  IF NOT (p_payload->>'enabled')::boolean THEN sections:='{}';writes:='{}';END IF;
  FOR dep IN SELECT * FROM (VALUES('deals.write',ARRAY['deals.view','leads.view','inventory.view']),('contracts.sign',ARRAY['deals.view']),('contracts.cancel',ARRAY['deals.view']),('contracts.terminate',ARRAY['deals.view']),('finance.payments.write',ARRAY['finance.payments','deals.view']),('finance.expenses.write',ARRAY['finance.expenses']),('construction.stock.write',ARRAY['construction.stock']),('documents.manage',ARRAY['documents.print','deals.view'])) t(w,r) LOOP
   IF dep.w=ANY(writes) AND NOT sections@>dep.r THEN RAISE EXCEPTION 'ACCESS_DEPENDENCIES_REQUIRED' USING ERRCODE='22023';END IF;
  END LOOP;
  IF 'documents.print'=ANY(sections) AND NOT 'deals.view'=ANY(sections) THEN RAISE EXCEPTION 'ACCESS_DEPENDENCIES_REQUIRED' USING ERRCODE='22023';END IF;
  IF (p_payload->>'enabled')::boolean AND (u.is_active<>1 OR cardinality(sections)=0) THEN RAISE EXCEPTION 'ACTIVE_SCOPED_USER_REQUIRED' USING ERRCODE='22023';END IF;
  PERFORM 1 FROM public.company_workspace_users WHERE user_id=u.id FOR UPDATE;
  IF (p_payload->>'enabled')::boolean AND EXISTS(SELECT 1 FROM public.company_workspace_users WHERE user_id=u.id AND NOT enabled) AND EXISTS(SELECT 1 FROM public.company_workspace_access WHERE user_id=u.id AND company_project_id<>p_project AND enabled) THEN RAISE EXCEPTION 'GLOBAL_PROFILE_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
  INSERT INTO public.company_workspace_users(user_id,enabled) VALUES(u.id,(p_payload->>'enabled')::boolean) ON CONFLICT(user_id) DO UPDATE SET enabled=CASE WHEN excluded.enabled THEN true ELSE public.company_workspace_users.enabled END;
  INSERT INTO public.company_workspace_access(user_id,company_project_id,enabled,sections,write_sections,revision) VALUES(u.id,p_project,(p_payload->>'enabled')::boolean,sections,writes,coalesce(a.revision,0)+1) ON CONFLICT(user_id,company_project_id) DO UPDATE SET enabled=excluded.enabled,sections=excluded.sections,write_sections=excluded.write_sections,revision=excluded.revision;
  result:=jsonb_build_object('id',u.id,'revision',coalesce(a.revision,0)+1,'enabled',(p_payload->>'enabled')::boolean);
 WHEN 'RESOURCE' THEN
  target:=p_payload->>'resource';resource_id:=(p_payload->>'id')::uuid;
  IF target NOT IN ('cash_desks','warehouses') THEN RAISE EXCEPTION 'INVALID_PROJECT_RESOURCE' USING ERRCODE='22023';END IF;
  IF resource_id IS NULL THEN
   IF length(btrim(p_payload->>'name')) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'RESOURCE_NAME_REQUIRED' USING ERRCODE='22023';END IF;
   resource_id:=gen_random_uuid();
   IF target='cash_desks' THEN INSERT INTO public.dictionaries(id,type,name,is_active) VALUES(resource_id,'CASH_DESK',btrim(p_payload->>'name'),true);
   ELSE INSERT INTO public.construction_warehouses(id,name,active) VALUES(resource_id,btrim(p_payload->>'name'),true);END IF;
  END IF;
  IF target='cash_desks' THEN
   PERFORM 1 FROM public.dictionaries WHERE id=resource_id AND type='CASH_DESK' AND is_active IS DISTINCT FROM false FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND' USING ERRCODE='P0002';END IF;
   SELECT company_project_id INTO owner FROM public.company_project_cash_desks WHERE cash_desk_id=resource_id;
   IF owner IS NOT NULL AND owner<>p_project THEN RAISE EXCEPTION 'RESOURCE_OWNED_BY_OTHER_PROJECT' USING ERRCODE='42501';END IF;
   IF EXISTS(SELECT 1 FROM public.payments WHERE cash_desk_id=resource_id) OR EXISTS(SELECT 1 FROM public.expenses WHERE cash_desk_id=resource_id) OR EXISTS(SELECT 1 FROM public.cash_transfers x WHERE to_jsonb(x)::text LIKE '%'||resource_id::text||'%') THEN RAISE EXCEPTION 'RESOURCE_HISTORY_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
   INSERT INTO public.company_project_cash_desks VALUES(resource_id,p_project) ON CONFLICT(cash_desk_id) DO NOTHING;
  ELSE
   PERFORM 1 FROM public.construction_warehouses WHERE id=resource_id AND active FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND' USING ERRCODE='P0002';END IF;
   SELECT company_project_id INTO owner FROM public.company_project_warehouses WHERE warehouse_id=resource_id;
   IF owner IS NOT NULL AND owner<>p_project THEN RAISE EXCEPTION 'RESOURCE_OWNED_BY_OTHER_PROJECT' USING ERRCODE='42501';END IF;
   IF EXISTS(SELECT 1 FROM public.construction_documents WHERE warehouse_id=resource_id OR destination_id=resource_id) OR EXISTS(SELECT 1 FROM public.construction_stock_entries WHERE warehouse_id=resource_id) THEN RAISE EXCEPTION 'RESOURCE_HISTORY_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
   INSERT INTO public.company_project_warehouses VALUES(resource_id,p_project) ON CONFLICT(warehouse_id) DO NOTHING;
  END IF;
  result:=jsonb_build_object('id',resource_id,'resource',target);
 WHEN 'BIND_DEMO_DEAL' THEN
  PERFORM 1 FROM public.company_project_complexes WHERE company_project_id=p_project FOR SHARE;
  SELECT * INTO d FROM public.deals WHERE id=(p_payload->>'deal_id')::integer FOR UPDATE;
  PERFORM 1 FROM public.leads WHERE id=d.lead_id FOR UPDATE;
  IF d.updated_at IS DISTINCT FROM p_payload->>'expected_updated_at' THEN RAISE EXCEPTION 'STALE_DEMO_DEAL' USING ERRCODE='40001';END IF;
  candidate:=tozon_internal.project_demo_binding(p_project,d.id);
  IF candidate->>'eligible'<>'true' THEN RAISE EXCEPTION 'DEAL_MIGRATION_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
  INSERT INTO public.company_project_leads(lead_id,company_project_id) VALUES(d.lead_id,p_project) ON CONFLICT(lead_id) DO UPDATE SET company_project_id=excluded.company_project_id WHERE public.company_project_leads.company_project_id=excluded.company_project_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'LEAD_OWNED_BY_OTHER_PROJECT' USING ERRCODE='42501';END IF;
  UPDATE public.deals SET company_project_id=p_project,updated_at=now()::text WHERE id=d.id;
  -- No price, payment, schedule, contract text or historical signer is rewritten.
  result:=jsonb_build_object('id',d.id,'signer_review_required',d.company_director_snapshot IS NULL);
 ELSE RAISE EXCEPTION 'INVALID_ADMIN_COMMAND' USING ERRCODE='22023';
 END CASE;
 INSERT INTO public.company_project_admin_commands(request_id,company_project_id,actor_id,kind,payload,result) VALUES(p_request,p_project,p_actor,p_kind,p_payload-'password_hash',result);
 RETURN result||jsonb_build_object('idempotent',false);
END $fn$;
REVOKE ALL ON FUNCTION public.read_company_project_setup(integer,uuid),public.read_company_project_unbound_deals(integer,uuid,integer),public.execute_company_project_admin(integer,uuid,uuid,text,jsonb),tozon_internal.project_demo_binding(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_company_project_setup(integer,uuid),public.read_company_project_unbound_deals(integer,uuid,integer),public.execute_company_project_admin(integer,uuid,uuid,text,jsonb),tozon_internal.project_demo_binding(uuid,integer) TO service_role;

-- Preserve configured memberships when editing directors or shares.
CREATE OR REPLACE FUNCTION public.save_company_project_draft(p_project_id uuid,p_expected_revision integer,p_payload jsonb,p_actor_id integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $function$
DECLARE
  v_id uuid; v_company uuid; v_revision integer; v_existing jsonb; v_result jsonb;
  v_partners jsonb; v_members jsonb; v_complexes jsonb;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=p_actor_id AND role='ADMIN' AND is_active=1) THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED' USING ERRCODE='42501';
  END IF;
  SELECT id INTO STRICT v_company FROM public.crm_companies WHERE code='TOZON';
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR
     EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('code','name','location','director_name','director_authority','partners','members','complex_ids')) THEN
    RAISE EXCEPTION 'INVALID_PROJECT_PAYLOAD' USING ERRCODE='22023';
  END IF;
  v_partners:=coalesce(p_payload->'partners','[]'::jsonb);
  v_members:=coalesce(p_payload->'members','[]'::jsonb);
  v_complexes:=coalesce(p_payload->'complex_ids','[]'::jsonb);
  IF jsonb_typeof(v_partners) IS DISTINCT FROM 'array' OR jsonb_typeof(v_members) IS DISTINCT FROM 'array' OR jsonb_typeof(v_complexes) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'INVALID_PROJECT_ARRAYS' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(v_partners)>50 OR jsonb_array_length(v_members)>500 OR jsonb_array_length(v_complexes)>500 THEN
    RAISE EXCEPTION 'PROJECT_LIMIT_EXCEEDED' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(v_partners)>0 AND (
    EXISTS(SELECT 1 FROM jsonb_array_elements(v_partners) p WHERE jsonb_typeof(p->'share_percent') IS DISTINCT FROM 'number' OR jsonb_typeof(p->'name') IS DISTINCT FROM 'string' OR
      (p->>'share_percent')::numeric<=0 OR (p->>'share_percent')::numeric>100 OR (p->>'share_percent')::numeric<>round((p->>'share_percent')::numeric,2)) OR
    (SELECT sum((p->>'share_percent')::numeric) FROM jsonb_array_elements(v_partners) p) IS DISTINCT FROM 100::numeric
  ) THEN RAISE EXCEPTION 'PARTNER_SHARES_MUST_TOTAL_100' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_members) m LEFT JOIN public.users u ON u.id=(m->>'user_id')::integer WHERE u.id IS NULL OR u.is_active<>1 OR m->>'project_role' IS NULL) THEN
    RAISE EXCEPTION 'INACTIVE_OR_UNKNOWN_MEMBER' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(v_complexes) c LEFT JOIN public.projects p ON p.id=c::integer WHERE p.id IS NULL OR p.archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'UNKNOWN_OR_ARCHIVED_COMPLEX' USING ERRCODE='23514';
  END IF;
  IF p_project_id IS NULL THEN
    IF p_expected_revision IS NOT NULL THEN RAISE EXCEPTION 'STALE_PROJECT' USING ERRCODE='40001'; END IF;
    INSERT INTO public.company_projects(company_id,code,name) VALUES(v_company,p_payload->>'code',p_payload->>'name') RETURNING id,revision INTO v_id,v_revision;
  ELSE
    SELECT id,revision INTO v_id,v_revision FROM public.company_projects WHERE id=p_project_id AND company_id=v_company FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF p_expected_revision IS NULL OR p_expected_revision<>v_revision THEN RAISE EXCEPTION 'STALE_PROJECT' USING ERRCODE='40001'; END IF;
    v_revision:=v_revision+1;
  END IF;
  UPDATE public.company_projects SET code=p_payload->>'code',name=p_payload->>'name',location=coalesce(p_payload->>'location',''),
    director_name=coalesce(p_payload->>'director_name',''),director_authority=coalesce(p_payload->>'director_authority',''),
    revision=v_revision,updated_at=now() WHERE id=v_id;
  -- All replacements, complex assignment and audit entry commit together.
  DELETE FROM public.company_project_partners WHERE company_project_id=v_id;
  INSERT INTO public.company_project_partners(company_project_id,name,share_percent)
    SELECT v_id,btrim(p->>'name'),(p->>'share_percent')::numeric FROM jsonb_array_elements(v_partners) p;
  IF EXISTS(SELECT 1 FROM public.company_workspace_access a WHERE a.company_project_id=v_id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_members) m WHERE (m->>'user_id')::integer=a.user_id)) THEN RAISE EXCEPTION 'MEMBERSHIP_HAS_ACCESS_HISTORY' USING ERRCODE='23514';END IF;
  DELETE FROM public.company_project_memberships x WHERE company_project_id=v_id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_members) m WHERE (m->>'user_id')::integer=x.user_id);
  INSERT INTO public.company_project_memberships(company_project_id,user_id,project_role)
    SELECT v_id,(m->>'user_id')::integer,m->>'project_role' FROM jsonb_array_elements(v_members) m ON CONFLICT(company_project_id,user_id) DO UPDATE SET project_role=excluded.project_role;
  IF EXISTS(SELECT 1 FROM public.company_project_complexes cp JOIN public.buildings b ON b.project_id=cp.complex_id JOIN public.sections s ON s.building_id=b.id JOIN public.floors f ON f.section_id=s.id JOIN public.units u ON u.floor_id=f.id JOIN public.deals d ON d.unit_id=u.id WHERE cp.company_project_id=v_id AND d.company_project_id=v_id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(v_complexes) x WHERE x::integer=cp.complex_id)) THEN RAISE EXCEPTION 'COMPLEX_HAS_PROJECT_HISTORY' USING ERRCODE='23514';END IF;
  DELETE FROM public.company_project_complexes WHERE company_project_id=v_id;
  INSERT INTO public.company_project_complexes(company_project_id,complex_id)
    SELECT v_id,c::integer FROM jsonb_array_elements_text(v_complexes) c;
  SELECT to_jsonb(p) || jsonb_build_object('partners',v_partners,'members',v_members,'complex_ids',v_complexes) INTO v_result FROM public.company_projects p WHERE id=v_id;
  INSERT INTO public.company_project_history(company_project_id,revision,actor_id,data) VALUES(v_id,v_revision,p_actor_id,v_result);
  RETURN v_result;
END $function$;
