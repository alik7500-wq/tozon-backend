-- No existing user gets document privileges. Files stay server-only.
ALTER TABLE public.company_workspace_access DROP CONSTRAINT company_workspace_access_sections_check;
ALTER TABLE public.company_workspace_access ADD CONSTRAINT company_workspace_sections_allowed CHECK(sections <@ ARRAY['inventory.view','leads.view','deals.view','finance.payments','finance.expenses','construction.stock','documents.print']::text[]);
ALTER TABLE public.company_workspace_access DROP CONSTRAINT company_workspace_write_sections_allowed;
ALTER TABLE public.company_workspace_access ADD CONSTRAINT company_workspace_write_sections_allowed CHECK(write_sections <@ ARRAY['deals.write','contracts.sign','finance.payments.write','finance.expenses.write','construction.stock.write','documents.manage']::text[]);

CREATE FUNCTION public.authorize_company_project_document(p_actor integer,p_project uuid,p_deal integer,p_write boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
 PERFORM public.read_company_project_workspace(p_actor,p_project,'deals',p_deal::text,'',1);
 PERFORM 1 FROM public.company_workspace_access WHERE user_id=p_actor AND company_project_id=p_project AND enabled AND 'documents.print'=ANY(sections) AND (NOT p_write OR 'documents.manage'=ANY(write_sections)) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'WORKSPACE_DOCUMENT_DENIED' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.deals WHERE id=p_deal AND company_project_id=p_project FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SCOPED_DOCUMENT_REQUIRED' USING ERRCODE='P0002';END IF;
END $fn$;
REVOKE ALL ON FUNCTION public.authorize_company_project_document(integer,uuid,integer,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_company_project_document(integer,uuid,integer,boolean) TO service_role;

CREATE FUNCTION public.read_company_project_document(p_actor integer,p_project uuid,p_deal integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE d public.deals; result jsonb;financial boolean;paid bigint:=0;credit bigint;p record;
BEGIN
 PERFORM public.authorize_company_project_document(p_actor,p_project,p_deal);
 SELECT * INTO STRICT d FROM public.deals WHERE id=p_deal;
 SELECT 'finance.payments'=ANY(sections) INTO financial FROM public.company_workspace_access WHERE user_id=p_actor AND company_project_id=p_project AND enabled;
 IF financial THEN
  FOR p IN SELECT x.*,cp.company_project_id AS cash_project FROM public.payments x LEFT JOIN public.company_project_cash_desks cp ON cp.cash_desk_id=x.cash_desk_id WHERE x.deal_id=d.id AND x.status IN ('ACTIVE','POSTED') LOOP
   IF p.cash_project IS DISTINCT FROM p_project THEN RAISE EXCEPTION 'DOCUMENT_PAYMENT_SCOPE_MISMATCH' USING ERRCODE='23514';END IF;
   credit:=CASE WHEN coalesce(p.currency,'USD')='USD' THEN coalesce(round(p.amount_usd*100)::bigint,p.amount_minor) WHEN p.amount_usd>0 THEN round(p.amount_usd*100)::bigint WHEN p.exchange_rate>0 THEN round(p.amount_minor::numeric/p.exchange_rate)::bigint ELSE NULL END;
   IF d.currency<>'USD' OR credit IS NULL THEN RAISE EXCEPTION 'DOCUMENT_PAYMENT_CURRENCY_UNRESOLVED' USING ERRCODE='23514';END IF;
   paid:=paid+credit;
  END LOOP;
 END IF;
 SELECT jsonb_build_object(
  'total_paid_minor',CASE WHEN financial THEN paid ELSE NULL END,
  'deal',jsonb_build_object('id',d.id,'contract_number',d.contract_number,'deal_date',d.deal_date,'status',d.status,'currency',d.currency,'payment_type',d.payment_type,'final_price_minor',d.final_price_minor,'down_payment_minor',d.down_payment_minor,'installment_months',d.installment_months,'deal_price_per_m2_minor',d.deal_price_per_m2_minor),
  'client',jsonb_build_object('full_name',l.full_name,'phone',l.phone,'passport_series',to_jsonb(l)->>'passport_series','passport_number',l.passport_number,'passport_issued_by',to_jsonb(l)->>'passport_issued_by','passport_issue_date',to_jsonb(l)->>'passport_issue_date','birth_date',to_jsonb(l)->>'birth_date','registration_address',to_jsonb(l)->>'registration_address','inn',to_jsonb(l)->>'inn'),
  'unit',jsonb_build_object('unit_number',u.unit_number,'unit_kind',u.unit_kind,'area_m2_x100',u.area_m2_x100,'rooms',to_jsonb(u)->>'rooms','project_id',c.id,'project_name',c.name,'project_address',c.address,'building_name',to_jsonb(b)->>'name','section_name',to_jsonb(s)->>'name','floor_number',to_jsonb(f)->>'floor_number'),
  'signer',d.company_director_snapshot,
  'company',coalesce((SELECT data->'company' FROM public.crm_document_settings WHERE id=1),'{}'::jsonb)-ARRAY['director_name','branch_name','accountant_name','cashier_name'],
  'financial',financial,
  'schedules',CASE WHEN financial THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'due_date',x.due_date,'amount_minor',x.amount_minor,'paid_amount_minor',x.paid_amount_minor,'status',x.status) ORDER BY x.due_date,x.id),'[]'::jsonb) FROM public.deal_payment_schedules x WHERE x.deal_id=d.id) ELSE '[]'::jsonb END,
  'files_upload',EXISTS(SELECT 1 FROM public.company_workspace_access WHERE user_id=p_actor AND company_project_id=p_project AND enabled AND 'documents.manage'=ANY(write_sections))
 ) INTO result FROM public.leads l JOIN public.units u ON u.id=d.unit_id JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id JOIN public.projects c ON c.id=b.project_id WHERE l.id=d.lead_id;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.read_company_project_document(integer,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_company_project_document(integer,uuid,integer) TO service_role;

CREATE TABLE public.company_project_files (
 id uuid PRIMARY KEY,company_project_id uuid NOT NULL REFERENCES public.company_projects(id) ON DELETE RESTRICT,
 deal_id integer NOT NULL REFERENCES public.deals(id) ON DELETE RESTRICT,
 original_name text NOT NULL CHECK(length(original_name) BETWEEN 1 AND 200 AND original_name !~ '[[:cntrl:]/\\]'),
 content_type text NOT NULL CHECK(content_type IN ('application/pdf','image/jpeg','image/png')),
 file_size integer NOT NULL CHECK(file_size BETWEEN 1 AND 10485760),sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 object_path text GENERATED ALWAYS AS (company_project_id::text||'/'||deal_id::text||'/'||id::text) STORED,
 created_by integer NOT NULL REFERENCES public.users(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX company_project_files_deal ON public.company_project_files(company_project_id,deal_id,id);
ALTER TABLE public.company_project_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_project_files FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.company_project_files TO service_role;
CREATE FUNCTION public.check_company_project_file() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
 PERFORM public.authorize_company_project_document(NEW.created_by,NEW.company_project_id,NEW.deal_id,true);
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.check_company_project_file() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.check_company_project_file() TO service_role;
CREATE TRIGGER company_project_files_scope BEFORE INSERT ON public.company_project_files FOR EACH ROW EXECUTE FUNCTION public.check_company_project_file();
-- Restrictive policy also blocks any unrelated permissive storage policy from
-- accidentally exposing this bucket to browser roles. Storage SDK uses service_role.
CREATE POLICY company_project_files_server_only ON storage.objects AS RESTRICTIVE FOR ALL TO anon,authenticated
 USING(bucket_id<>'company-project-private') WITH CHECK(bucket_id<>'company-project-private');

CREATE FUNCTION public.read_company_project_files(p_actor integer,p_project uuid,p_deal integer,p_file uuid DEFAULT NULL,p_after text DEFAULT '',p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE rows jsonb;f public.company_project_files;
BEGIN
 PERFORM public.authorize_company_project_document(p_actor,p_project,p_deal);
 IF p_file IS NOT NULL THEN
  SELECT * INTO f FROM public.company_project_files WHERE id=p_file AND company_project_id=p_project AND deal_id=p_deal;
  IF NOT FOUND THEN RAISE EXCEPTION 'FILE_NOT_FOUND' USING ERRCODE='P0002';END IF;
  RETURN to_jsonb(f);
 END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR length(coalesce(p_after,''))>40 THEN RAISE EXCEPTION 'INVALID_FILE_PAGE' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(x)-'object_path'-'company_project_id'-'deal_id'-'created_by' ORDER BY id),'[]'::jsonb) INTO rows FROM (SELECT * FROM public.company_project_files WHERE company_project_id=p_project AND deal_id=p_deal AND id::text>coalesce(p_after,'') ORDER BY id LIMIT p_limit+1) x;
 RETURN jsonb_build_object('records',CASE WHEN jsonb_array_length(rows)>p_limit THEN rows-p_limit ELSE rows END,'has_more',jsonb_array_length(rows)>p_limit);
END $fn$;
REVOKE ALL ON FUNCTION public.read_company_project_files(integer,uuid,integer,uuid,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_company_project_files(integer,uuid,integer,uuid,text,integer) TO service_role;

CREATE FUNCTION public.register_company_project_file(p_actor integer,p_project uuid,p_deal integer,p_id uuid,p_name text,p_type text,p_size integer,p_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE f public.company_project_files;
BEGIN
 PERFORM public.authorize_company_project_document(p_actor,p_project,p_deal,true);
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('workspace-file:'||p_id::text,0));
 SELECT * INTO f FROM public.company_project_files WHERE id=p_id;
 IF FOUND THEN
  IF f.company_project_id<>p_project OR f.deal_id<>p_deal OR f.created_by<>p_actor OR f.original_name<>p_name OR f.content_type<>p_type OR f.file_size<>p_size OR f.sha256<>p_hash THEN RAISE EXCEPTION 'FILE_REQUEST_REUSED' USING ERRCODE='23505';END IF;
 ELSE
  INSERT INTO public.company_project_files(id,company_project_id,deal_id,original_name,content_type,file_size,sha256,created_by) VALUES(p_id,p_project,p_deal,p_name,p_type,p_size,p_hash,p_actor) RETURNING * INTO f;
 END IF;
 RETURN to_jsonb(f)-'object_path'-'company_project_id'-'deal_id'-'created_by';
END $fn$;
REVOKE ALL ON FUNCTION public.register_company_project_file(integer,uuid,integer,uuid,text,text,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.register_company_project_file(integer,uuid,integer,uuid,text,text,integer,text) TO service_role;
