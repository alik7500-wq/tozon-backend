-- Unpaid closure only. Paid/barter/refund contracts require a dedicated settlement flow.
ALTER TABLE public.company_workspace_access DROP CONSTRAINT company_workspace_write_sections_allowed;
ALTER TABLE public.company_workspace_access ADD CONSTRAINT company_workspace_write_sections_allowed CHECK(write_sections <@ ARRAY['deals.write','contracts.sign','contracts.cancel','contracts.terminate','finance.payments.write','finance.expenses.write','construction.stock.write','documents.manage']::text[]);
ALTER TABLE public.company_project_commands DROP CONSTRAINT company_project_commands_kind_allowed;
ALTER TABLE public.company_project_commands ADD CONSTRAINT company_project_commands_kind_allowed CHECK(kind IN ('DEAL_DRAFT','SIGN_DEAL','CANCEL_DRAFT','TERMINATE_UNPAID','PAYMENT','EXPENSE','STOCK_POST'));
ALTER TABLE public.deals ADD COLUMN company_closure_snapshot jsonb CHECK(company_closure_snapshot IS NULL OR jsonb_typeof(company_closure_snapshot)='object');

ALTER FUNCTION public.execute_company_project_command(integer,uuid,uuid,text,jsonb) RENAME TO execute_company_project_v4_command;
REVOKE ALL ON FUNCTION public.execute_company_project_v4_command(integer,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.execute_company_project_command(p_actor integer,p_project uuid,p_request uuid,p_kind text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE d public.deals;u public.units;h public.company_project_commands;needed text;reason text;basis text;basis_date date;result jsonb;closed_at timestamptz:=clock_timestamp();
BEGIN
 IF p_kind NOT IN ('CANCEL_DRAFT','TERMINATE_UNPAID') OR p_kind IS NULL THEN RETURN public.execute_company_project_v4_command(p_actor,p_project,p_request,p_kind,p_payload);END IF;
 needed:=CASE p_kind WHEN 'CANCEL_DRAFT' THEN 'contracts.cancel' ELSE 'contracts.terminate' END;
 IF p_request IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('deal_id','expected_updated_at','reason','basis','basis_date')) THEN RAISE EXCEPTION 'INVALID_CLOSURE_COMMAND' USING ERRCODE='22023';END IF;
 PERFORM public.read_company_project_workspace(p_actor,p_project,'deals',p_payload->>'deal_id','',1);
 -- These locks keep revocation and project reassignment from racing the command.
 PERFORM 1 FROM public.users x JOIN public.company_workspace_users w ON w.user_id=x.id WHERE x.id=p_actor AND x.is_active=1 AND w.enabled AND coalesce(x.permissions,'[]'::jsonb)?'company.project-only' FOR SHARE OF x,w;
 IF NOT FOUND THEN RAISE EXCEPTION 'WORKSPACE_ACCESS_DENIED' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.company_workspace_access WHERE user_id=p_actor AND company_project_id=p_project AND enabled AND needed=ANY(write_sections) AND 'deals.view'=ANY(sections) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'WORKSPACE_CLOSURE_DENIED' USING ERRCODE='42501';END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('workspace-command:'||p_request::text,0));
 SELECT * INTO h FROM public.company_project_commands WHERE request_id=p_request;
 IF FOUND THEN
  IF h.actor_id<>p_actor OR h.company_project_id<>p_project OR h.kind<>p_kind OR h.payload<>p_payload THEN RAISE EXCEPTION 'WORKSPACE_REQUEST_REUSED' USING ERRCODE='23505';END IF;
  RETURN h.result||jsonb_build_object('idempotent',true);
 END IF;
 SELECT * INTO d FROM public.deals WHERE id=(p_payload->>'deal_id')::integer AND company_project_id=p_project FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SCOPED_DRAFT_REQUIRED' USING ERRCODE='42501';END IF;
 IF d.company_closure_snapshot IS NOT NULL OR d.status<>(CASE p_kind WHEN 'CANCEL_DRAFT' THEN 'DRAFT' ELSE 'SIGNED' END) OR p_payload->>'expected_updated_at' IS NULL OR p_payload->>'expected_updated_at' IS DISTINCT FROM d.updated_at THEN RAISE EXCEPTION 'STALE_CLOSURE_TARGET' USING ERRCODE='40001';END IF;
 reason:=btrim(p_payload->>'reason');basis:=btrim(p_payload->>'basis');
 IF jsonb_typeof(p_payload->'reason') IS DISTINCT FROM 'string' OR reason IS NULL OR length(reason) NOT BETWEEN 5 AND 1000 THEN RAISE EXCEPTION 'CLOSURE_REASON_REQUIRED' USING ERRCODE='22023';END IF;
 IF p_kind='TERMINATE_UNPAID' THEN
  IF jsonb_typeof(p_payload->'basis') IS DISTINCT FROM 'string' OR jsonb_typeof(p_payload->'basis_date') IS DISTINCT FROM 'string' OR (p_payload->>'basis_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'TERMINATION_BASIS_REQUIRED' USING ERRCODE='22023';END IF;
  basis_date:=(p_payload->>'basis_date')::date;
  IF basis IS NULL OR length(basis) NOT BETWEEN 3 AND 500 OR basis_date IS NULL OR basis_date<d.deal_date::date OR basis_date>(now() AT TIME ZONE 'Asia/Dushanbe')::date THEN RAISE EXCEPTION 'TERMINATION_BASIS_REQUIRED' USING ERRCODE='22023';END IF;
 ELSIF p_payload?'basis' OR p_payload?'basis_date' THEN RAISE EXCEPTION 'INVALID_DRAFT_CLOSURE_FIELDS' USING ERRCODE='22023';END IF;
 SELECT * INTO u FROM public.units WHERE id=d.unit_id FOR UPDATE;
 PERFORM 1 FROM public.floors f JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id JOIN public.projects c ON c.id=b.project_id JOIN public.company_project_complexes cp ON cp.complex_id=c.id JOIN public.company_project_leads cl ON cl.lead_id=d.lead_id
  WHERE f.id=u.floor_id AND cp.company_project_id=p_project AND cl.company_project_id=p_project AND u.archived_at IS NULL AND f.archived_at IS NULL AND s.archived_at IS NULL AND b.archived_at IS NULL AND c.archived_at IS NULL FOR SHARE OF f,s,b,c,cp,cl;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_LINK_CHANGED' USING ERRCODE='42501';END IF;
 IF u.status<>(CASE p_kind WHEN 'CANCEL_DRAFT' THEN 'RESERVED' ELSE 'SOLD' END) OR EXISTS(SELECT 1 FROM public.deals WHERE unit_id=u.id AND id<>d.id AND status IN ('DRAFT','RESERVED','SIGNED')) THEN RAISE EXCEPTION 'CLOSURE_UNIT_REQUIRES_REVIEW' USING ERRCODE='23514';END IF;
 -- Even voided financial history is retained and routed for explicit review.
 IF EXISTS(SELECT 1 FROM public.payments WHERE deal_id=d.id) OR EXISTS(SELECT 1 FROM public.expenses WHERE deal_id=d.id) OR EXISTS(SELECT 1 FROM public.deal_payment_schedules WHERE deal_id=d.id AND (coalesce(paid_amount_minor,0)<>0 OR status IN ('PAID','PARTIAL'))) OR d.payment_type IN ('BARTER','PARTIAL_BARTER') OR coalesce((to_jsonb(d)->>'barter_amount_minor')::bigint,0)>0 OR coalesce(to_jsonb(d)->'vehicle_details','null'::jsonb)<>'null'::jsonb OR to_jsonb(d)->>'refund_expense_id' IS NOT NULL OR coalesce((to_jsonb(d)->>'paid_at_termination_minor')::bigint,0)>0 OR coalesce((to_jsonb(d)->>'refund_amount_minor')::bigint,0)>0 THEN RAISE EXCEPTION 'CLOSURE_FINANCIAL_REVIEW_REQUIRED' USING ERRCODE='23514';END IF;
 result:=jsonb_build_object('resource','deals','id',d.id,'status','CANCELLED','unit_status','AVAILABLE');
 INSERT INTO public.company_project_commands(request_id,company_project_id,actor_id,kind,payload,result) VALUES(p_request,p_project,p_actor,p_kind,p_payload,result);
 UPDATE public.deal_payment_schedules SET status='CANCELLED',updated_at=closed_at WHERE deal_id=d.id;
 UPDATE public.deals SET status='CANCELLED',cancelled_at=closed_at::text,cancellation_reason=reason,updated_at=closed_at::text,company_closure_snapshot=jsonb_build_object('request_id',p_request,'kind',p_kind,'previous_status',d.status,'actor_id',p_actor,'closed_at',closed_at,'reason',reason,'basis',basis,'basis_date',basis_date) WHERE id=d.id;
 UPDATE public.units SET status='AVAILABLE',updated_at=closed_at::text WHERE id=u.id;
 RETURN result||jsonb_build_object('idempotent',false);
END $fn$;
REVOKE ALL ON FUNCTION public.execute_company_project_command(integer,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.execute_company_project_command(integer,uuid,uuid,text,jsonb) TO service_role;

CREATE FUNCTION tozon_internal.guard_company_closed_deal() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.company_project_id IS NOT NULL THEN RAISE EXCEPTION 'SCOPED_DEAL_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;RETURN OLD;
 END IF;
 IF OLD.company_project_id IS NOT NULL AND OLD.status='SIGNED' AND NEW.status NOT IN ('SIGNED','CANCELLED') THEN RAISE EXCEPTION 'SIGNED_PROJECT_DEAL_REQUIRES_REVIEW' USING ERRCODE='23514';END IF;
 IF NEW.company_project_id IS NOT NULL AND NEW.status='CANCELLED' AND OLD.status<>'CANCELLED' THEN
  IF NEW.company_closure_snapshot IS NULL OR NOT EXISTS(
   SELECT 1 FROM public.company_project_commands h WHERE h.request_id::text=NEW.company_closure_snapshot->>'request_id' AND h.company_project_id=NEW.company_project_id AND h.actor_id::text=NEW.company_closure_snapshot->>'actor_id' AND h.kind=NEW.company_closure_snapshot->>'kind' AND h.kind=CASE OLD.status WHEN 'DRAFT' THEN 'CANCEL_DRAFT' WHEN 'SIGNED' THEN 'TERMINATE_UNPAID' ELSE '' END AND h.payload->>'deal_id'=NEW.id::text AND h.payload->>'expected_updated_at'=OLD.updated_at AND h.payload->>'reason'=NEW.company_closure_snapshot->>'reason'
  ) THEN RAISE EXCEPTION 'PROJECT_CLOSURE_COMMAND_REQUIRED' USING ERRCODE='23514';END IF;
 END IF;
 IF OLD.company_closure_snapshot IS NOT NULL AND (to_jsonb(NEW)-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at') THEN RAISE EXCEPTION 'CLOSED_PROJECT_DEAL_IMMUTABLE' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION tozon_internal.guard_company_closed_deal() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION tozon_internal.guard_company_closed_deal() TO service_role;
CREATE TRIGGER company_closed_deal_immutable BEFORE UPDATE OR DELETE ON public.deals FOR EACH ROW EXECUTE FUNCTION tozon_internal.guard_company_closed_deal();

CREATE FUNCTION tozon_internal.guard_company_financial_history() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE d public.deals;
BEGIN
 IF TG_OP IN ('DELETE','UPDATE') AND OLD.deal_id IS NOT NULL THEN
  SELECT * INTO d FROM public.deals WHERE id=OLD.deal_id FOR SHARE;
  IF d.company_project_id IS NOT NULL AND (TG_OP='DELETE' OR NEW.deal_id IS DISTINCT FROM OLD.deal_id) THEN RAISE EXCEPTION 'SCOPED_FINANCIAL_HISTORY_IMMUTABLE' USING ERRCODE='23514';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 IF NEW.deal_id IS NOT NULL THEN
  SELECT * INTO d FROM public.deals WHERE id=NEW.deal_id FOR SHARE;
  IF d.company_project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.company_project_cash_desks WHERE company_project_id=d.company_project_id AND cash_desk_id=NEW.cash_desk_id) THEN RAISE EXCEPTION 'CASH_DESK_OUTSIDE_PROJECT' USING ERRCODE='42501';END IF;
  IF d.company_project_id IS NOT NULL AND d.status<>'SIGNED' THEN RAISE EXCEPTION 'PROJECT_DEAL_NOT_SIGNED' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION tozon_internal.guard_company_financial_history() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION tozon_internal.guard_company_financial_history() TO service_role;
CREATE TRIGGER company_payment_history BEFORE INSERT OR UPDATE OR DELETE ON public.payments FOR EACH ROW EXECUTE FUNCTION tozon_internal.guard_company_financial_history();
CREATE TRIGGER company_expense_history BEFORE INSERT OR UPDATE OR DELETE ON public.expenses FOR EACH ROW EXECUTE FUNCTION tozon_internal.guard_company_financial_history();

CREATE FUNCTION tozon_internal.guard_company_closed_schedule() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE d public.deals;
BEGIN
 IF TG_OP IN ('DELETE','UPDATE') THEN
  SELECT * INTO d FROM public.deals WHERE id=OLD.deal_id FOR SHARE;
  IF d.company_closure_snapshot IS NOT NULL AND (TG_OP='DELETE' OR (to_jsonb(NEW)-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at')) THEN RAISE EXCEPTION 'CLOSED_PROJECT_SCHEDULE_IMMUTABLE' USING ERRCODE='23514';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 SELECT * INTO d FROM public.deals WHERE id=NEW.deal_id FOR SHARE;
 IF d.company_closure_snapshot IS NOT NULL AND (TG_OP='INSERT' OR NEW.status<>'CANCELLED') THEN RAISE EXCEPTION 'CLOSED_PROJECT_SCHEDULE_IMMUTABLE' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION tozon_internal.guard_company_closed_schedule() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION tozon_internal.guard_company_closed_schedule() TO service_role;
CREATE TRIGGER company_closed_schedule BEFORE INSERT OR UPDATE OR DELETE ON public.deal_payment_schedules FOR EACH ROW EXECUTE FUNCTION tozon_internal.guard_company_closed_schedule();

ALTER FUNCTION public.company_project_operation_options(integer,uuid,text,text,integer) RENAME TO company_project_v4_operation_options;
REVOKE ALL ON FUNCTION public.company_project_v4_operation_options(integer,uuid,text,text,integer) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.company_project_operation_options(p_actor integer,p_project uuid,p_kind text DEFAULT 'context',p_after text DEFAULT '',p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE result jsonb;commands jsonb;rights text[];target text;rows jsonb;
BEGIN
 IF p_kind NOT IN ('context','cancel_drafts','terminate_deals') THEN RETURN public.company_project_v4_operation_options(p_actor,p_project,p_kind,p_after,p_limit);END IF;
 IF p_kind='context' THEN
  result:=public.company_project_v4_operation_options(p_actor,p_project,p_kind,p_after,p_limit);commands:=result->'commands';
  SELECT CASE WHEN 'deals.view'=ANY(sections) THEN write_sections ELSE '{}'::text[] END INTO rights FROM public.company_workspace_access WHERE user_id=p_actor AND company_project_id=p_project AND enabled;
  IF 'contracts.cancel'=ANY(rights) THEN commands:=commands||'"CANCEL_DRAFT"'::jsonb;END IF;
  IF 'contracts.terminate'=ANY(rights) THEN commands:=commands||'"TERMINATE_UNPAID"'::jsonb;END IF;
  RETURN result||jsonb_build_object('commands',commands);
 END IF;
 PERFORM public.read_company_project_workspace(p_actor,p_project,'deals',NULL,'',1);
 SELECT write_sections INTO rights FROM public.company_workspace_access WHERE user_id=p_actor AND company_project_id=p_project AND enabled;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR length(coalesce(p_after,''))>40 THEN RAISE EXCEPTION 'INVALID_OPTIONS_PAGE' USING ERRCODE='22023';END IF;
 IF NOT (CASE p_kind WHEN 'cancel_drafts' THEN 'contracts.cancel' ELSE 'contracts.terminate' END=ANY(rights)) THEN RAISE EXCEPTION 'WORKSPACE_CLOSURE_DENIED' USING ERRCODE='42501';END IF;
 target:=CASE p_kind WHEN 'cancel_drafts' THEN 'DRAFT' ELSE 'SIGNED' END;
 SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id::text),'[]'::jsonb) INTO rows FROM (
  SELECT d.id,coalesce(d.contract_number,'Черновик')||' · '||l.full_name||' · №'||u.unit_number AS name,d.status,d.updated_at,d.deal_date
  FROM public.deals d JOIN public.units u ON u.id=d.unit_id JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id JOIN public.projects c ON c.id=b.project_id JOIN public.company_project_complexes cp ON cp.complex_id=c.id JOIN public.leads l ON l.id=d.lead_id JOIN public.company_project_leads cl ON cl.lead_id=l.id
  WHERE d.company_project_id=p_project AND cp.company_project_id=p_project AND cl.company_project_id=p_project AND d.status=target AND u.archived_at IS NULL AND f.archived_at IS NULL AND s.archived_at IS NULL AND b.archived_at IS NULL AND c.archived_at IS NULL AND d.id::text>coalesce(p_after,'') ORDER BY d.id::text LIMIT p_limit+1
 ) x;
 RETURN jsonb_build_object('records',CASE WHEN jsonb_array_length(rows)>p_limit THEN rows-p_limit ELSE rows END,'has_more',jsonb_array_length(rows)>p_limit,'project_id',p_project);
END $fn$;
REVOKE ALL ON FUNCTION public.company_project_operation_options(integer,uuid,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.company_project_operation_options(integer,uuid,text,text,integer) TO service_role;

-- Expose the closure basis only through the separately authorized document reader.
ALTER FUNCTION public.read_company_project_document(integer,uuid,integer) RENAME TO read_company_project_v5_document;
REVOKE ALL ON FUNCTION public.read_company_project_v5_document(integer,uuid,integer) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.read_company_project_document(p_actor integer,p_project uuid,p_deal integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE result jsonb;closure jsonb;
BEGIN
 result:=public.read_company_project_v5_document(p_actor,p_project,p_deal);
 SELECT company_closure_snapshot INTO closure FROM public.deals WHERE id=p_deal AND company_project_id=p_project;
 RETURN result||jsonb_build_object('closure',closure);
END $fn$;
REVOKE ALL ON FUNCTION public.read_company_project_document(integer,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_company_project_document(integer,uuid,integer) TO service_role;
