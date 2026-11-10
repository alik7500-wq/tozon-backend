-- Run only against the isolated commercial test database.
-- Every fixture, mapping, actor and membership is rolled back.
BEGIN;
DO $guard$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.projects WHERE code='DEMO-001') OR
     EXISTS(SELECT 1 FROM public.projects WHERE code IN ('25601','TOZON-PLAZA-2')) THEN
    RAISE EXCEPTION 'ISOLATED_DEMO_DATABASE_REQUIRED';
  END IF;
END $guard$;
-- Exercise the real SQL queue path without committing or calling a provider.
INSERT INTO public.sms_templates(code,name,text,is_active) VALUES('CONTRACT_CREATED','Isolation fixture','Isolation only - rolled back',true) ON CONFLICT(code) DO UPDATE SET is_active=true;
INSERT INTO public.sms_notification_rules(event_type,group_name,name,template_code,enabled,mode) VALUES('CONTRACT_CREATED','Isolation','Isolation fixture','CONTRACT_CREATED',true,'CONFIRM') ON CONFLICT(event_type) DO UPDATE SET enabled=true,mode='CONFIRM';
CREATE FUNCTION pg_temp.clone_workspace_fixture(p_table text,p_patch jsonb) RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE v_id integer; v_row jsonb; v_sequence text; v_exists boolean;
BEGIN
  IF p_table NOT IN ('users','projects','buildings','sections','floors','units','leads','deals') THEN RAISE EXCEPTION 'Invalid fixture table'; END IF;
  v_sequence:=pg_catalog.pg_get_serial_sequence('public.'||p_table,'id');
  IF v_sequence IS NULL THEN
    EXECUTE format('SELECT coalesce(max(id),0)+1 FROM public.%I',p_table) INTO v_id;
  ELSE
    LOOP
      EXECUTE 'SELECT nextval($1::regclass)' INTO v_id USING v_sequence;
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE id=$1)',p_table) INTO v_exists USING v_id;
      EXIT WHEN NOT v_exists;
    END LOOP;
  END IF;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t ORDER BY id LIMIT 1',p_table) INTO v_row;
  IF v_row IS NULL THEN RAISE EXCEPTION 'Missing synthetic template for %',p_table; END IF;
  EXECUTE format('INSERT INTO public.%I SELECT (jsonb_populate_record(NULL::public.%I,$1)).*',p_table,p_table) USING v_row || p_patch || jsonb_build_object('id',v_id);
  RETURN v_id;
END $fn$;
CREATE TEMP TABLE workspace_smoke_actors(slot integer,actor integer,project uuid,unit_id integer,lead_id integer,deal_id integer) ON COMMIT DROP;
GRANT SELECT ON workspace_smoke_actors TO service_role;
DO $setup$
DECLARE slot integer; actor integer; cp uuid; complex integer; building integer; section_id integer; floor_id integer; unit_id integer; lead_id integer; deal_id integer; warehouse uuid;
BEGIN
  FOR slot IN 1..2 LOOP
    actor:=pg_temp.clone_workspace_fixture('users',jsonb_build_object('name','Isolation pilot '||slot,'email','workspace-isolation-'||slot||'@example.invalid','role','ADMIN','is_active',1,'permissions',jsonb_build_array('company.project-only')));
    SELECT id INTO STRICT cp FROM public.company_projects WHERE code=CASE slot WHEN 1 THEN 'TOZON_PLAZA' ELSE 'TOZON_TOWER' END;
    complex:=pg_temp.clone_workspace_fixture('projects',jsonb_build_object('name','Isolation complex '||slot,'code','WORKSPACE-ISO-'||slot,'archived_at',NULL));
    building:=pg_temp.clone_workspace_fixture('buildings',jsonb_build_object('project_id',complex,'code','ISO-'||slot,'archived_at',NULL));
    section_id:=pg_temp.clone_workspace_fixture('sections',jsonb_build_object('building_id',building,'code','ISO-'||slot,'archived_at',NULL));
    floor_id:=pg_temp.clone_workspace_fixture('floors',jsonb_build_object('section_id',section_id,'archived_at',NULL));
    unit_id:=pg_temp.clone_workspace_fixture('units',jsonb_build_object('floor_id',floor_id,'unit_number','ISO-'||slot,'archived_at',NULL));
    lead_id:=pg_temp.clone_workspace_fixture('leads',jsonb_build_object('full_name','Isolation client '||slot,'phone','TEST-INVALID-'||slot,'responsible_user_id',actor,'interested_project_id',complex,'archived_at',NULL));
    -- DRAFT does not queue reservation/signature SMS. No payments/expenses are inserted.
    deal_id:=pg_temp.clone_workspace_fixture('deals',jsonb_build_object('unit_id',unit_id,'lead_id',lead_id,'responsible_user_id',actor,'contract_number','ISO-'||slot,'status','DRAFT'));
    INSERT INTO public.company_project_complexes VALUES(complex,cp);
    INSERT INTO public.company_project_leads VALUES(lead_id,cp);
    INSERT INTO public.company_project_memberships(company_project_id,user_id,project_role) VALUES(cp,actor,'PARTNER');
    INSERT INTO public.company_workspace_users VALUES(actor,true);
    INSERT INTO public.company_workspace_access VALUES(actor,cp,ARRAY['inventory.view','leads.view','deals.view','finance.payments','finance.expenses','construction.stock'],true);
    INSERT INTO public.construction_warehouses(name,active) VALUES('Isolation warehouse '||slot,true) RETURNING id INTO warehouse;
    INSERT INTO public.company_project_warehouses VALUES(warehouse,cp);
    INSERT INTO workspace_smoke_actors VALUES(slot,actor,cp,unit_id,lead_id,deal_id);
  END LOOP;
END $setup$;
SET LOCAL ROLE service_role;
DO $assert$
DECLARE a record; other_project uuid; other_lead integer; kind text; result jsonb; amount integer;
BEGIN
  FOR a IN SELECT * FROM workspace_smoke_actors LOOP
    SELECT project,lead_id INTO STRICT other_project,other_lead FROM workspace_smoke_actors WHERE slot<>a.slot;
    result:=public.read_company_project_workspace(a.actor,NULL,'projects');
    IF jsonb_array_length(result->'projects')<>1 OR result->'projects'->0->>'id'<>a.project::text THEN RAISE EXCEPTION 'Project catalog leaked'; END IF;
    FOREACH kind IN ARRAY ARRAY['complexes','units','leads','deals','payments','schedules','expenses','warehouses'] LOOP
      result:=public.read_company_project_workspace(a.actor,a.project,kind);
      amount:=CASE WHEN kind IN ('payments','schedules','expenses') THEN 0 ELSE 1 END;
      IF jsonb_array_length(result->'records')<>amount THEN RAISE EXCEPTION 'Unexpected own data: %',kind; END IF;
      BEGIN
        PERFORM public.read_company_project_workspace(a.actor,other_project,kind);
        RAISE EXCEPTION 'Cross-project data accepted: %',kind;
      EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    END LOOP;
    BEGIN
      PERFORM public.read_company_project_workspace(a.actor,a.project,'leads',other_lead::text);
      RAISE EXCEPTION 'Foreign record ID accepted';
    EXCEPTION WHEN no_data_found THEN NULL; END;
    UPDATE public.company_workspace_access SET enabled=false WHERE user_id=a.actor;
    BEGIN
      PERFORM public.read_company_project_workspace(a.actor,a.project,'units');
      RAISE EXCEPTION 'Revoked session accepted';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    UPDATE public.company_workspace_access SET enabled=true WHERE user_id=a.actor;
  END LOOP;
END $assert$;

-- Financial and stock effects stay in this transaction; nothing is committed.
DO $writes$
DECLARE a record; foreign_project uuid; foreign_lead integer; own_floor integer; available_unit integer; another_unit integer;
 desk uuid; foreign_desk uuid; supplier uuid; material uuid; warehouse uuid; foreign_warehouse uuid;
 request uuid; payload jsonb; result jsonb; again jsonb; failed boolean; command_count integer; signed_deal integer; own_complex integer; scheme uuid; scheme_version timestamptz;
BEGIN
 FOR a IN SELECT * FROM workspace_smoke_actors ORDER BY slot LOOP
  SELECT project,lead_id INTO STRICT foreign_project,foreign_lead FROM workspace_smoke_actors WHERE slot<>a.slot;
  UPDATE public.company_workspace_access SET write_sections=ARRAY['deals.write','contracts.sign','finance.payments.write','finance.expenses.write','construction.stock.write'] WHERE user_id=a.actor;
  INSERT INTO public.dictionaries(type,name,code,is_active) VALUES('CASH_DESK','Isolation cash '||a.slot,'WORKSPACE-ISO-CASH-'||a.slot,true) RETURNING id INTO desk;
  INSERT INTO public.company_project_cash_desks VALUES(desk,a.project);
  UPDATE public.deals SET status='SIGNED',payment_type='INSTALLMENT',installment_months=1,currency='USD',down_payment_minor=0,final_price_minor=20000000 WHERE id=a.deal_id;
  INSERT INTO public.deal_payment_schedules(deal_id,payment_number,due_date,amount_minor,paid_amount_minor,status,created_at,updated_at) VALUES(a.deal_id,1,'2026-12-10',20000000,0,'UPCOMING',now()::text,now()::text);
  request:=gen_random_uuid();payload:=jsonb_build_object('cash_desk_id',desk,'deal_id',a.deal_id,'amount_minor',100000,'currency','USD','date','2026-11-10');
  result:=public.execute_company_project_command(a.actor,a.project,request,'PAYMENT',payload);
  again:=public.execute_company_project_command(a.actor,a.project,request,'PAYMENT',payload);
  IF result->>'status'<>'ACTIVE' OR again->>'id'<>result->>'id' OR again->>'idempotent'<>'true' THEN RAISE EXCEPTION 'Payment/retry failed';END IF;
  BEGIN
   PERFORM public.execute_company_project_command(a.actor,a.project,request,'PAYMENT',payload||'{"amount_minor":200000}'::jsonb);
   RAISE EXCEPTION 'Changed request accepted';
  EXCEPTION WHEN unique_violation THEN NULL;END;
  result:=public.execute_company_project_command(a.actor,a.project,gen_random_uuid(),'PAYMENT',jsonb_build_object('cash_desk_id',desk,'deal_id',a.deal_id,'amount_minor',92400,'currency','TJS','exchange_rate',9.24,'date','2026-11-10'));
  IF (SELECT sum(paid_amount_minor) FROM public.deal_payment_schedules WHERE deal_id=a.deal_id)<>110000 THEN RAISE EXCEPTION 'TJS credited without correct USD conversion';END IF;
  result:=public.execute_company_project_command(a.actor,a.project,gen_random_uuid(),'EXPENSE',jsonb_build_object('cash_desk_id',desk,'amount_minor',9240,'currency','TJS','exchange_rate',9.24,'date','2026-11-10','category','TJS isolation test'));
  result:=public.execute_company_project_command(a.actor,a.project,gen_random_uuid(),'EXPENSE',jsonb_build_object('cash_desk_id',desk,'amount_minor',1000,'currency','USD','date','2026-11-10','category','Isolation test','recipient','Test supplier'));
  IF result->>'resource'<>'expenses' THEN RAISE EXCEPTION 'Expense failed';END IF;
  failed:=false;
  BEGIN
   PERFORM public.execute_company_project_command(a.actor,a.project,gen_random_uuid(),'EXPENSE',jsonb_build_object('cash_desk_id',desk,'amount_minor',99999999,'currency','USD','date','2026-11-10','category','Insufficient test'));
  EXCEPTION WHEN raise_exception THEN failed:=true;END;
  IF NOT failed THEN RAISE EXCEPTION 'Insufficient funds accepted';END IF;
  SELECT floor_id INTO STRICT own_floor FROM public.units WHERE id=a.unit_id;
  available_unit:=pg_temp.clone_workspace_fixture('units',jsonb_build_object('floor_id',own_floor,'unit_number','CMD-'||a.slot,'status','AVAILABLE','archived_at',NULL));
  result:=public.execute_company_project_command(a.actor,a.project,gen_random_uuid(),'DEAL_DRAFT',jsonb_build_object('unit_id',available_unit,'lead_id',a.lead_id,'final_price_minor',1000000,'date','2026-11-10'));
  IF result->>'status'<>'DRAFT' OR NOT EXISTS(SELECT 1 FROM public.deals WHERE id=(result->>'id')::integer AND company_project_id=a.project AND company_director_snapshot IS NOT NULL) THEN RAISE EXCEPTION 'Project draft/snapshot failed';END IF;
  signed_deal:=(result->>'id')::integer;
  UPDATE public.company_projects SET director_name='Isolation director '||a.slot,director_authority='Isolation authority' WHERE id=a.project;
  UPDATE public.units SET unit_kind='APARTMENT',area_m2_x100=6000,price_per_m2_minor=70000 WHERE id=available_unit;
  SELECT b.project_id INTO STRICT own_complex FROM public.floors f JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id WHERE f.id=own_floor;
  INSERT INTO public.discount_schemes(project_id,name,rules,is_active) VALUES(own_complex,'Isolation two offers','[{"payment_percent":0,"price_per_m2":640,"discount_percent":8.57,"months":36},{"payment_percent":0,"price_per_m2":700,"discount_percent":0,"months":40}]'::jsonb,true) RETURNING id,updated_at INTO scheme,scheme_version;
  IF NOT (public.company_project_operation_options(a.actor,a.project)->'commands' ? 'SIGN_DEAL') THEN RAISE EXCEPTION 'Missing signing action';END IF;
  BEGIN
   PERFORM public.company_project_operation_options(a.actor,foreign_project,'deals');
   RAISE EXCEPTION 'Foreign form options accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;END;
  payload:=jsonb_build_object('deal_id',signed_deal,'expected_updated_at',(SELECT updated_at FROM public.deals WHERE id=signed_deal),'scheme_id',scheme,'scheme_updated_at',scheme_version,'rule_key',CASE a.slot WHEN 1 THEN '[0,640,8.57,36]' ELSE '[0,700,0,40]' END,'down_payment_minor',0,'installment_months',CASE a.slot WHEN 1 THEN 36 ELSE 40 END);
  request:=gen_random_uuid();result:=public.execute_company_project_command(a.actor,a.project,request,'SIGN_DEAL',payload);
  again:=public.execute_company_project_command(a.actor,a.project,request,'SIGN_DEAL',payload);
  IF result->>'status'<>'SIGNED' OR again->>'idempotent'<>'true' OR (SELECT sum(amount_minor) FROM public.deal_payment_schedules WHERE deal_id=signed_deal)<>(result->>'final_price_minor')::integer OR (SELECT count(*) FROM public.deal_payment_schedules WHERE deal_id=signed_deal)<>(CASE a.slot WHEN 1 THEN 36 ELSE 40 END) THEN RAISE EXCEPTION 'Signing schedule / exact offer failed';END IF;
  result:=public.execute_company_project_command(a.actor,a.project,gen_random_uuid(),'PAYMENT',jsonb_build_object('cash_desk_id',desk,'deal_id',signed_deal,'amount_minor',92400,'currency','TJS','exchange_rate',9.24,'date','2026-11-10'));
  IF (SELECT sum(paid_amount_minor) FROM public.deal_payment_schedules WHERE deal_id=signed_deal)<>10000 THEN RAISE EXCEPTION 'Signed deal payment/FIFO failed';END IF;
  -- Document privileges are separate from contract/finance access.
  BEGIN
   PERFORM public.read_company_project_document(a.actor,a.project,signed_deal);
   RAISE EXCEPTION 'Implicit document access accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;END;
  UPDATE public.company_workspace_access SET sections=array_append(sections,'documents.print'),write_sections=array_append(write_sections,'documents.manage') WHERE user_id=a.actor;
  result:=public.read_company_project_document(a.actor,a.project,signed_deal);
  IF result->'signer'->>'director_name'<>'Isolation director '||a.slot OR (result->>'total_paid_minor')::integer<>10000 THEN RAISE EXCEPTION 'Document snapshot/FX total failed';END IF;
  request:=gen_random_uuid();result:=public.register_company_project_file(a.actor,a.project,signed_deal,request,'isolation.pdf','application/pdf',100,repeat('a',64));
  again:=public.register_company_project_file(a.actor,a.project,signed_deal,request,'isolation.pdf','application/pdf',100,repeat('a',64));
  IF result<>again OR result?'object_path' THEN RAISE EXCEPTION 'File metadata retry/privacy failed';END IF;
  result:=public.read_company_project_files(a.actor,a.project,signed_deal);
  IF jsonb_array_length(result->'records')<>1 OR result->'records'->0 ? 'object_path' THEN RAISE EXCEPTION 'File catalog leaked path';END IF;
  BEGIN
   PERFORM public.read_company_project_document(a.actor,foreign_project,signed_deal);
   RAISE EXCEPTION 'Foreign document accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;END;
  UPDATE public.company_workspace_access SET sections=array_remove(sections,'documents.print') WHERE user_id=a.actor;
  BEGIN
   PERFORM public.read_company_project_files(a.actor,a.project,signed_deal,request);
   RAISE EXCEPTION 'Revoked document grant accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;END;
  UPDATE public.company_workspace_access SET sections=array_append(sections,'documents.print') WHERE user_id=a.actor;
  another_unit:=pg_temp.clone_workspace_fixture('units',jsonb_build_object('floor_id',own_floor,'unit_number','REJECT-'||a.slot,'status','AVAILABLE','archived_at',NULL));
  BEGIN
   PERFORM public.execute_company_project_command(a.actor,a.project,gen_random_uuid(),'DEAL_DRAFT',jsonb_build_object('unit_id',another_unit,'lead_id',foreign_lead,'final_price_minor',1000000,'date','2026-11-10'));
   RAISE EXCEPTION 'Foreign client accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;END;
  IF (SELECT status FROM public.units WHERE id=another_unit)<>'AVAILABLE' THEN RAISE EXCEPTION 'Failed command changed unit';END IF;
  INSERT INTO public.construction_parties(name,kind,active) VALUES('Isolation supplier '||a.slot,'SUPPLIER',true) RETURNING id INTO supplier;
  INSERT INTO public.company_project_parties VALUES(supplier,a.project);
  INSERT INTO public.construction_materials(name,unit,active) VALUES('Isolation material '||a.slot,'шт',true) RETURNING id INTO material;
  SELECT warehouse_id INTO STRICT warehouse FROM public.company_project_warehouses WHERE company_project_id=a.project;
  SELECT warehouse_id INTO STRICT foreign_warehouse FROM public.company_project_warehouses WHERE company_project_id=foreign_project;
  payload:=jsonb_build_object('kind','RECEIPT','date','2026-11-10','currency','USD','warehouse_id',warehouse,'party_id',supplier,'basis','Isolation transaction test','lines',jsonb_build_array(jsonb_build_object('material_id',material,'quantity',2,'value',20)));
  request:=gen_random_uuid();result:=public.execute_company_project_command(a.actor,a.project,request,'STOCK_POST',payload);
  again:=public.execute_company_project_command(a.actor,a.project,request,'STOCK_POST',payload);
  IF result->>'status'<>'POSTED' OR again->>'id'<>result->>'id' OR (SELECT sum(quantity) FROM public.construction_stock_entries WHERE material_id=material)<>2 THEN RAISE EXCEPTION 'Stock or duplicate ledger failed';END IF;
  BEGIN
   PERFORM public.execute_company_project_command(a.actor,a.project,gen_random_uuid(),'STOCK_POST',payload||jsonb_build_object('kind','TRANSFER','destination_id',foreign_warehouse));
   RAISE EXCEPTION 'Foreign warehouse accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;END;
  result:=public.execute_company_project_command(a.actor,a.project,gen_random_uuid(),'EXPENSE',jsonb_build_object('cash_desk_id',desk,'amount_minor',100,'currency','USD','date','2026-11-10','category','Supplier settlement','settlement_party_id',supplier,'settlement_account','PAYABLE'));
  IF result->>'resource'<>'expenses' THEN RAISE EXCEPTION 'Supplier settlement expense failed';END IF;
 END LOOP;
 SELECT count(*) INTO command_count FROM public.company_project_commands;
 IF command_count<>18 THEN RAISE EXCEPTION 'Unexpected duplicate or missing commands: %',command_count;END IF;
END $writes$;
DO $closure$
DECLARE a record;own_floor integer;unit_id integer;closure_deal integer;request uuid;payload jsonb;result jsonb;again jsonb;stamp text;message text;
BEGIN
 FOR a IN SELECT * FROM workspace_smoke_actors ORDER BY slot LOOP
  UPDATE public.company_workspace_access SET write_sections=write_sections||ARRAY['contracts.cancel','contracts.terminate'] WHERE user_id=a.actor;
  SELECT d.id,d.updated_at INTO STRICT closure_deal,stamp FROM public.deals d WHERE d.company_project_id=a.project AND d.status='SIGNED';
  BEGIN
   PERFORM public.execute_company_project_command(a.actor,a.project,gen_random_uuid(),'TERMINATE_UNPAID',jsonb_build_object('deal_id',closure_deal,'expected_updated_at',stamp,'reason','Paid contract must be reviewed','basis','Isolation agreement','basis_date','2026-11-10'));
   RAISE EXCEPTION 'Paid termination accepted';
  EXCEPTION WHEN check_violation THEN
   GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
   IF message<>'CLOSURE_FINANCIAL_REVIEW_REQUIRED' THEN RAISE;END IF;
  END;
  SELECT floor_id INTO STRICT own_floor FROM public.units WHERE id=a.unit_id;
  unit_id:=pg_temp.clone_workspace_fixture('units',jsonb_build_object('floor_id',own_floor,'unit_number','CLOSE-'||a.slot,'status','AVAILABLE','unit_kind','APARTMENT','area_m2_x100',6000,'price_per_m2_minor',70000,'manual_total_price_minor',NULL,'archived_at',NULL));
  result:=public.execute_company_project_command(a.actor,a.project,gen_random_uuid(),'DEAL_DRAFT',jsonb_build_object('unit_id',unit_id,'lead_id',a.lead_id,'final_price_minor',4200000,'date','2026-11-10'));closure_deal:=(result->>'id')::integer;
  SELECT updated_at INTO STRICT stamp FROM public.deals WHERE id=closure_deal;
  request:=gen_random_uuid();payload:=jsonb_build_object('deal_id',closure_deal,'expected_updated_at',stamp,'reason','Client cancelled draft');
  result:=public.execute_company_project_command(a.actor,a.project,request,'CANCEL_DRAFT',payload);again:=public.execute_company_project_command(a.actor,a.project,request,'CANCEL_DRAFT',payload);
  IF result->>'status'<>'CANCELLED' OR again->>'idempotent'<>'true' OR (SELECT status FROM public.units WHERE id=unit_id)<>'AVAILABLE' THEN RAISE EXCEPTION 'Draft cancellation/retry failed';END IF;
  result:=public.execute_company_project_command(a.actor,a.project,gen_random_uuid(),'DEAL_DRAFT',jsonb_build_object('unit_id',unit_id,'lead_id',a.lead_id,'final_price_minor',4200000,'date','2026-11-10'));closure_deal:=(result->>'id')::integer;
  -- A replay of the old cancellation must not release the newly reserved unit.
  PERFORM public.execute_company_project_command(a.actor,a.project,request,'CANCEL_DRAFT',payload);
  IF (SELECT status FROM public.units WHERE id=unit_id)<>'RESERVED' THEN RAISE EXCEPTION 'Cancellation replay changed new reservation';END IF;
  SELECT updated_at INTO STRICT stamp FROM public.deals WHERE id=closure_deal;
  PERFORM public.execute_company_project_command(a.actor,a.project,gen_random_uuid(),'SIGN_DEAL',jsonb_build_object('deal_id',closure_deal,'expected_updated_at',stamp,'down_payment_minor',0,'installment_months',36));
  SELECT updated_at INTO STRICT stamp FROM public.deals WHERE id=closure_deal;
  PERFORM public.execute_company_project_command(a.actor,a.project,gen_random_uuid(),'TERMINATE_UNPAID',jsonb_build_object('deal_id',closure_deal,'expected_updated_at',stamp,'reason','Parties ended unpaid contract','basis','Isolation agreement','basis_date','2026-11-10'));
  IF (SELECT status FROM public.units WHERE id=unit_id)<>'AVAILABLE' OR (SELECT count(*) FROM public.deal_payment_schedules WHERE deal_id=closure_deal AND status='CANCELLED')<36 THEN RAISE EXCEPTION 'Unpaid termination failed';END IF;
  result:=public.read_company_project_document(a.actor,a.project,closure_deal);
  IF result->'closure'->>'kind'<>'TERMINATE_UNPAID' OR result->'signer'->>'director_name'<>'Isolation director '||a.slot THEN RAISE EXCEPTION 'Closure document history failed';END IF;
  BEGIN
   UPDATE public.deals SET status='SIGNED' WHERE id=closure_deal;
   RAISE EXCEPTION 'Closed deal reopened';
  EXCEPTION WHEN check_violation THEN NULL;END;
 END LOOP;
 IF (SELECT count(*) FROM public.company_project_commands)<>28 THEN RAISE EXCEPTION 'Unexpected closure command count';END IF;
END $closure$;
DO $background$
DECLARE a record;global_actor integer;legacy_lead integer;legacy_unit integer;legacy_deal integer;demo_floor integer;affected integer;event_id bigint;target uuid;
BEGIN
 global_actor:=pg_temp.clone_workspace_fixture('users',jsonb_build_object('name','Legacy background control','email','background-control@example.invalid','role','ADMIN','is_active',1,'permissions','[]'::jsonb));
 FOR a IN SELECT * FROM workspace_smoke_actors ORDER BY slot LOOP
  IF EXISTS(SELECT 1 FROM public.sms_events WHERE client_id=a.lead_id) THEN RAISE EXCEPTION 'Project SQL trigger leaked a legacy SMS event';END IF;
  UPDATE public.leads SET phone='+99200000000'||a.slot WHERE id=a.lead_id;
  IF NOT public.company_project_background_blocked(jsonb_build_object('phone','+99200000000'||a.slot)) THEN RAISE EXCEPTION 'Phone-only project send was not blocked';END IF;
  INSERT INTO public.sms_messages(client_id,deal_id,phone,message,status) VALUES(a.lead_id,a.deal_id,'+99200000000'||a.slot,'Isolation only','queued');GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>0 THEN RAISE EXCEPTION 'Project SMS attempt admitted';END IF;
  INSERT INTO public.user_notifications(user_id,event_type,type,title,message,entity_type,entity_id,metadata) VALUES(global_actor,'LEAD_CREATED','LEAD_CREATED','Isolation','Isolation','LEAD',a.lead_id,jsonb_build_object('lead_id',a.lead_id));GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>0 THEN RAISE EXCEPTION 'Project notification broadcast admitted';END IF;
  INSERT INTO public.user_notifications(user_id,event_type,type,title,message,metadata) VALUES(a.actor,'LEAD_CREATED','LEAD_CREATED','Legacy broadcast','Isolation','{}');GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>0 THEN RAISE EXCEPTION 'Legacy broadcast reached project recipient';END IF;
  INSERT INTO public.tasks(lead_id,assigned_user_id,title,status) VALUES(a.lead_id,global_actor,'Isolation task','OPEN');GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected<>0 THEN RAISE EXCEPTION 'Project automatic task admitted';END IF;
 END LOOP;
 IF NOT public.company_project_background_blocked('{"global_export":true}'::jsonb) THEN RAISE EXCEPTION 'Shared export admitted with scoped footprint';END IF;
 SELECT f.id INTO STRICT demo_floor FROM public.floors f JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id JOIN public.projects c ON c.id=b.project_id WHERE c.code='DEMO-001' ORDER BY f.id LIMIT 1;
 legacy_lead:=pg_temp.clone_workspace_fixture('leads',jsonb_build_object('full_name','Legacy isolation control','phone','+992000000009','secondary_phone',NULL,'interested_project_id',NULL,'responsible_user_id',global_actor,'archived_at',NULL));
 legacy_unit:=pg_temp.clone_workspace_fixture('units',jsonb_build_object('floor_id',demo_floor,'unit_number','BG-LEGACY','status','SOLD','archived_at',NULL));
 legacy_deal:=pg_temp.clone_workspace_fixture('deals',jsonb_build_object('unit_id',legacy_unit,'lead_id',legacy_lead,'responsible_user_id',global_actor,'contract_number','BG-LEGACY','status','SIGNED','company_project_id',NULL,'company_director_snapshot',NULL,'company_closure_snapshot',NULL));
 SELECT id INTO STRICT event_id FROM public.sms_events WHERE deal_id=legacy_deal AND event_type='CONTRACT_CREATED';
 INSERT INTO public.user_notifications(user_id,event_type,type,title,message,entity_type,entity_id,metadata) VALUES(global_actor,'LEAD_CREATED','LEAD_CREATED','Legacy control','Isolation','LEAD',legacy_lead,jsonb_build_object('lead_id',legacy_lead));GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>1 THEN RAISE EXCEPTION 'Legacy notification no longer works';END IF;
 SELECT project INTO STRICT target FROM workspace_smoke_actors WHERE slot=1;
 INSERT INTO public.company_project_leads VALUES(legacy_lead,target);
 UPDATE public.sms_events SET status='PROCESSING' WHERE id=event_id;GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>0 THEN RAISE EXCEPTION 'Pre-existing event claimed after project assignment';END IF;
 UPDATE public.sms_events SET status='CANCELLED',cancel_reason='Isolation check' WHERE id=event_id;GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>1 THEN RAISE EXCEPTION 'Historical event cancellation was lost';END IF;
END $background$;
DO $reminders$
DECLARE a record;admin_id integer;other_actor integer;other_project uuid;result jsonb;notice uuid;
BEGIN
 admin_id:=pg_temp.clone_workspace_fixture('users',jsonb_build_object('name','Reminder settings control','email','reminder-control@example.invalid','role','ADMIN','is_active',1,'permissions','[]'::jsonb));
 FOR a IN SELECT * FROM workspace_smoke_actors ORDER BY slot LOOP
  SELECT actor,project INTO STRICT other_actor,other_project FROM workspace_smoke_actors WHERE slot<>a.slot;
  PERFORM public.save_company_project_reminders(admin_id,a.project,0,true,3,'2026-11-10');
  PERFORM public.refresh_company_project_reminders(a.project);
  IF public.refresh_company_project_reminders(a.project)<>0 THEN RAISE EXCEPTION 'Duplicate project reminders';END IF;
  result:=public.read_company_project_reminders(a.actor,a.project);
  IF jsonb_array_length(result->'records')<>1 OR result->'records'->0->>'client_name'<>'Isolation client '||a.slot THEN RAISE EXCEPTION 'Reminder scope, schedule or closure filter failed';END IF;
  notice:=(result->'records'->0->>'id')::uuid;
  BEGIN
   PERFORM public.ack_company_project_reminder(other_actor,other_project,notice);
   RAISE EXCEPTION 'Foreign reminder acknowledged';
  EXCEPTION WHEN no_data_found THEN NULL;END;
  result:=public.ack_company_project_reminder(a.actor,a.project,notice);
  IF result->>'is_read'<>'true' THEN RAISE EXCEPTION 'Own reminder not acknowledged';END IF;
  UPDATE public.company_workspace_access SET sections=array_remove(sections,'finance.payments') WHERE user_id=a.actor;
  BEGIN
   PERFORM public.read_company_project_reminders(a.actor,a.project);
   RAISE EXCEPTION 'Revoked reminder permission accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;END;
  UPDATE public.company_workspace_access SET sections=array_append(sections,'finance.payments') WHERE user_id=a.actor;
  PERFORM public.save_company_project_reminders(admin_id,a.project,1,false,3,'2026-11-10');
  result:=public.read_company_project_reminders(a.actor,a.project);
  IF jsonb_array_length(result->'records')<>0 THEN RAISE EXCEPTION 'Disabled reminders still visible';END IF;
 END LOOP;
END $reminders$;
ROLLBACK;
SELECT 'PASS: two project actors, drafts, exact 36/40-month signing, options, PKO/FIFO, RKO/balances, supplier settlements, stock ledgers, private document/file metadata, draft cancellation, unpaid termination and safe unit resale and legacy background quarantine, isolated internal reminders, read acknowledgement and permission revocation; all rows rolled back' AS result;
