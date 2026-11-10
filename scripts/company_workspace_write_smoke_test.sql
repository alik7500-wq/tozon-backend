-- Run only against the isolated commercial test database.
-- Every fixture, mapping, actor and membership is rolled back.
BEGIN;
DO $guard$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.projects WHERE code='DEMO-001') OR
     EXISTS(SELECT 1 FROM public.projects WHERE code IN ('25601','TOZON-PLAZA-2')) THEN
    RAISE EXCEPTION 'ISOLATED_DEMO_DATABASE_REQUIRED';
  END IF;
END $guard$;
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
 request uuid; payload jsonb; result jsonb; again jsonb; failed boolean; command_count integer;
BEGIN
 FOR a IN SELECT * FROM workspace_smoke_actors ORDER BY slot LOOP
  SELECT project,lead_id INTO STRICT foreign_project,foreign_lead FROM workspace_smoke_actors WHERE slot<>a.slot;
  UPDATE public.company_workspace_access SET write_sections=ARRAY['deals.write','finance.payments.write','finance.expenses.write','construction.stock.write'] WHERE user_id=a.actor;
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
 IF command_count<>14 THEN RAISE EXCEPTION 'Unexpected duplicate or missing commands: %',command_count;END IF;
END $writes$;
ROLLBACK;
SELECT 'PASS: two project actors, draft contracts, PKO/FIFO, RKO/balances, supplier settlements, stock ledgers and retries; all rows rolled back' AS result;
