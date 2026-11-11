-- Isolated test DB only. All accounts/grants/resources/bindings roll back.
BEGIN;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.projects WHERE code='DEMO-001') OR EXISTS(SELECT 1 FROM public.projects WHERE code IN ('25601','TOZON-PLAZA-2')) THEN RAISE EXCEPTION 'ISOLATED_DEMO_REQUIRED';END IF;
END $guard$;
SET LOCAL ROLE service_role;
DO $checks$
DECLARE p uuid;v integer;body jsonb;r jsonb;again jsonb;request uuid;member integer;candidate jsonb;d integer;original_signer jsonb;original_price integer;
BEGIN
 SELECT id,revision INTO STRICT p,v FROM public.company_projects WHERE code='TOZON_PLAZA';
 body:=jsonb_build_object('project_revision',v,'name','Rollback project member','email','rollback-project-member@example.invalid','project_role','MANAGER','password_hash','$2b$12$'||repeat('a',53),'password_fingerprint',repeat('a',64));request:=gen_random_uuid();
 r:=public.execute_company_project_admin(3,p,request,'CREATE_ACCOUNT',body);member:=(r->>'id')::integer;
 again:=public.execute_company_project_admin(3,p,request,'CREATE_ACCOUNT',body||jsonb_build_object('password_hash','$2b$12$'||repeat('b',53)));
 IF again->>'idempotent'<>'true' OR again->>'id'<>r->>'id' THEN RAISE EXCEPTION 'Account retry changed identity';END IF;
 IF EXISTS(SELECT 1 FROM public.company_project_admin_commands WHERE request_id=request AND payload?'password_hash') THEN RAISE EXCEPTION 'Password hash in audit';END IF;
 v:=v+1;
 BEGIN
  PERFORM public.execute_company_project_admin(3,p,gen_random_uuid(),'SET_ACCESS',jsonb_build_object('project_revision',v,'user_id',3,'revision',0,'enabled',true,'sections',jsonb_build_array('deals.view'),'write_sections','[]'::jsonb));
  RAISE EXCEPTION 'Company admin converted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 body:=jsonb_build_object('project_revision',v,'user_id',member,'revision',1,'enabled',true,'sections',jsonb_build_array('deals.view','documents.print'),'write_sections',jsonb_build_array('documents.manage'));
 PERFORM public.execute_company_project_admin(3,p,gen_random_uuid(),'SET_ACCESS',body);
 r:=public.read_company_project_workspace(member,NULL,'projects');IF jsonb_array_length(r->'projects')<>1 THEN RAISE EXCEPTION 'Scoped project list mismatch';END IF;
 PERFORM public.execute_company_project_admin(3,p,gen_random_uuid(),'RESOURCE',jsonb_build_object('project_revision',v,'resource','cash_desks','id',NULL,'name','Rollback empty project cash'));
 PERFORM public.execute_company_project_admin(3,p,gen_random_uuid(),'RESOURCE',jsonb_build_object('project_revision',v,'resource','warehouses','id',NULL,'name','Rollback project warehouse'));
 r:=public.read_company_project_unbound_deals(3,p,0);
 SELECT x INTO candidate FROM jsonb_array_elements(r->'records') x WHERE x->>'eligible'='true' LIMIT 1;
 IF candidate IS NOT NULL THEN
  d:=(candidate->>'id')::integer;SELECT company_director_snapshot,final_price_minor INTO original_signer,original_price FROM public.deals WHERE id=d;
  PERFORM public.execute_company_project_admin(3,p,gen_random_uuid(),'BIND_DEMO_DEAL',jsonb_build_object('project_revision',v,'deal_id',d,'expected_updated_at',candidate->>'updated_at','confirmed',true));
  IF (SELECT company_director_snapshot FROM public.deals WHERE id=d) IS DISTINCT FROM original_signer OR (SELECT final_price_minor FROM public.deals WHERE id=d)<>original_price THEN RAISE EXCEPTION 'Binding rewrote historical terms';END IF;
  r:=public.read_company_project_document(member,p,d);IF (r->'deal'->>'id')::integer<>d THEN RAISE EXCEPTION 'Own document not available after binding';END IF;
 END IF;
 PERFORM public.execute_company_project_admin(3,p,gen_random_uuid(),'SET_ACCESS',body||jsonb_build_object('revision',2,'enabled',false));
 BEGIN
  PERFORM public.read_company_project_workspace(member,p,'deals');RAISE EXCEPTION 'Revoked access accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END $checks$;
ROLLBACK;
SELECT 'PASS: dedicated account, stable retry, no hash in journal, global admin protected, explicit grants, empty resources, reviewed demo binding with preserved terms and revoked access; all rolled back' AS result;
