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
DECLARE v_id integer; v_row jsonb;
BEGIN
  IF p_table NOT IN ('users','projects','buildings','sections','floors','units','leads','deals') THEN RAISE EXCEPTION 'Invalid fixture table'; END IF;
  EXECUTE format('SELECT coalesce(max(id),0)+1 FROM public.%I',p_table) INTO v_id;
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
ROLLBACK;
SELECT 'PASS: two isolated actors, 8 resources, foreign IDs, live revocation; fixtures rolled back' AS result;
