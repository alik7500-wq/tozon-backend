-- Keep project data out of legacy cross-company automation until dedicated
-- project settings, recipients and sender credentials are explicitly implemented.
CREATE FUNCTION public.company_project_background_blocked(p_context jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE k text;v text;row_data jsonb;related jsonb;suffix text;
BEGIN
 IF p_context IS NULL OR jsonb_typeof(p_context)<>'object' THEN RETURN true;END IF;
 IF p_context->>'global_export'='true' AND (EXISTS(SELECT 1 FROM public.company_workspace_users) OR EXISTS(SELECT 1 FROM public.users WHERE coalesce(permissions,'[]'::jsonb)?'company.project-only') OR EXISTS(SELECT 1 FROM public.company_project_complexes) OR EXISTS(SELECT 1 FROM public.company_project_leads) OR EXISTS(SELECT 1 FROM public.company_project_cash_desks) OR EXISTS(SELECT 1 FROM public.deals WHERE company_project_id IS NOT NULL)) THEN RETURN true;END IF;
 IF p_context->>'company_project_id' IS NOT NULL THEN RETURN true;END IF;
 FOREACH k IN ARRAY ARRAY['deal_id','contract_id','client_id','lead_id','payment_id','schedule_id','task_id','sms_message_id','unit_id','complex_id'] LOOP
  v:=p_context->>k;IF v IS NULL OR v='' THEN CONTINUE;END IF;
  IF v !~ '^[1-9][0-9]{0,18}$' THEN RETURN true;END IF;
  row_data:=NULL;related:=NULL;
  CASE k
   WHEN 'deal_id','contract_id' THEN
    SELECT to_jsonb(d) INTO row_data FROM public.deals d WHERE d.id=v::bigint;
    IF row_data->>'company_project_id' IS NOT NULL THEN RETURN true;END IF;
    related:=jsonb_build_object('unit_id',row_data->'unit_id','lead_id',row_data->'lead_id');
   WHEN 'client_id','lead_id' THEN
    SELECT to_jsonb(l) INTO row_data FROM public.leads l WHERE l.id=v::bigint;
    IF EXISTS(SELECT 1 FROM public.company_project_leads WHERE lead_id=v::bigint) THEN RETURN true;END IF;
    related:=jsonb_build_object('complex_id',row_data->'interested_project_id','phone',row_data->'phone','secondary_phone',row_data->'secondary_phone');
   WHEN 'payment_id' THEN
    SELECT to_jsonb(x) INTO row_data FROM public.payments x WHERE x.id=v::bigint;
    IF EXISTS(SELECT 1 FROM public.company_project_cash_desks WHERE cash_desk_id=(row_data->>'cash_desk_id')::uuid) THEN RETURN true;END IF;
    related:=jsonb_build_object('deal_id',row_data->'deal_id');
   WHEN 'schedule_id' THEN
    SELECT to_jsonb(x) INTO row_data FROM public.deal_payment_schedules x WHERE x.id=v::bigint;
    related:=jsonb_build_object('deal_id',row_data->'deal_id');
   WHEN 'task_id' THEN
    SELECT to_jsonb(x) INTO row_data FROM public.tasks x WHERE x.id=v::bigint;
    IF EXISTS(SELECT 1 FROM public.company_workspace_users WHERE user_id=(row_data->>'assigned_user_id')::integer) OR EXISTS(SELECT 1 FROM public.users WHERE id=(row_data->>'assigned_user_id')::integer AND coalesce(permissions,'[]'::jsonb)?'company.project-only') THEN RETURN true;END IF;
    related:=jsonb_build_object('deal_id',row_data->'deal_id','lead_id',row_data->'lead_id','phone',row_data->'phone');
   WHEN 'sms_message_id' THEN
    SELECT to_jsonb(x) INTO row_data FROM public.sms_messages x WHERE x.id=v::bigint;
    related:=jsonb_build_object('deal_id',row_data->'deal_id','contract_id',row_data->'contract_id','client_id',row_data->'client_id','payment_id',row_data->'payment_id','phone',row_data->'phone');
   WHEN 'unit_id' THEN
    SELECT jsonb_build_object('id',u.id,'complex_id',b.project_id) INTO row_data FROM public.units u JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id WHERE u.id=v::bigint;
    related:=jsonb_build_object('complex_id',row_data->'complex_id');
   WHEN 'complex_id' THEN
    SELECT jsonb_build_object('id',id) INTO row_data FROM public.projects WHERE id=v::bigint;
    IF EXISTS(SELECT 1 FROM public.company_project_complexes WHERE complex_id=v::bigint) THEN RETURN true;END IF;
  END CASE;
  IF row_data IS NULL THEN RETURN true;END IF;
  IF related IS NOT NULL AND public.company_project_background_blocked(related) THEN RETURN true;END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['phone','secondary_phone'] LOOP
  v:=p_context->>k;IF v IS NULL OR v='' THEN CONTINUE;END IF;
  suffix:=right(regexp_replace(v,'[^0-9]','','g'),9);
  IF length(suffix)<9 THEN RETURN true;END IF;
  IF EXISTS(
   SELECT 1 FROM public.leads l WHERE (right(regexp_replace(coalesce(l.phone,''),'[^0-9]','','g'),9)=suffix OR right(regexp_replace(coalesce(to_jsonb(l)->>'secondary_phone',''),'[^0-9]','','g'),9)=suffix)
    AND (EXISTS(SELECT 1 FROM public.company_project_leads cp WHERE cp.lead_id=l.id) OR EXISTS(SELECT 1 FROM public.deals d WHERE d.lead_id=l.id AND d.company_project_id IS NOT NULL) OR EXISTS(SELECT 1 FROM public.company_project_complexes cp WHERE cp.complex_id=(to_jsonb(l)->>'interested_project_id')::integer))
  ) THEN RETURN true;END IF;
 END LOOP;
 RETURN false;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION public.company_project_background_blocked(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.company_project_background_blocked(jsonb) TO service_role;

CREATE FUNCTION tozon_internal.quarantine_project_sms() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE ctx jsonb:=to_jsonb(NEW);affected boolean;
BEGIN
 affected:=public.company_project_background_blocked(ctx);
 IF TG_OP='UPDATE' THEN affected:=affected OR public.company_project_background_blocked(to_jsonb(OLD));END IF;
 -- Retain actual outcome/cancellation records for pre-existing attempts. This
 -- trigger prevents admission/claim; it never rewrites a sent/unknown history.
 IF affected AND (TG_OP='INSERT' OR upper(coalesce(ctx->>'status','')) IN ('AWAITING_CONFIRMATION','PROCESSING','QUEUED','SENDING')) THEN RETURN NULL;END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION tozon_internal.quarantine_project_sms() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION tozon_internal.quarantine_project_sms() TO service_role;
CREATE TRIGGER company_sms_event_quarantine BEFORE INSERT OR UPDATE ON public.sms_events FOR EACH ROW EXECUTE FUNCTION tozon_internal.quarantine_project_sms();
CREATE TRIGGER company_sms_message_quarantine BEFORE INSERT OR UPDATE ON public.sms_messages FOR EACH ROW EXECUTE FUNCTION tozon_internal.quarantine_project_sms();

CREATE FUNCTION tozon_internal.quarantine_project_notification() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE ctx jsonb:=coalesce(NEW.metadata,'{}'::jsonb);recipient integer:=NEW.user_id;
BEGIN
 IF EXISTS(SELECT 1 FROM public.company_workspace_users WHERE user_id=recipient) OR EXISTS(SELECT 1 FROM public.users WHERE id=recipient AND coalesce(permissions,'[]'::jsonb)?'company.project-only') THEN RETURN NULL;END IF;
 CASE upper(coalesce(NEW.entity_type,''))
  WHEN 'DEAL' THEN ctx:=ctx||jsonb_build_object('deal_id',NEW.entity_id);
  WHEN 'LEAD' THEN ctx:=ctx||jsonb_build_object('lead_id',NEW.entity_id);
  WHEN 'PAYMENT' THEN ctx:=ctx||jsonb_build_object('payment_id',NEW.entity_id);
  WHEN 'SCHEDULE' THEN ctx:=ctx||jsonb_build_object('schedule_id',NEW.entity_id);
  WHEN 'TASK' THEN ctx:=ctx||jsonb_build_object('task_id',NEW.entity_id);
  WHEN 'SMS' THEN ctx:=ctx||jsonb_build_object('sms_message_id',NEW.entity_id);
  ELSE NULL;
 END CASE;
 IF public.company_project_background_blocked(ctx) THEN RETURN NULL;END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION tozon_internal.quarantine_project_notification() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION tozon_internal.quarantine_project_notification() TO service_role;
CREATE TRIGGER company_notification_quarantine BEFORE INSERT ON public.user_notifications FOR EACH ROW EXECUTE FUNCTION tozon_internal.quarantine_project_notification();

CREATE FUNCTION tozon_internal.quarantine_project_task() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
 IF public.company_project_background_blocked(to_jsonb(NEW)) THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM public.company_workspace_users WHERE user_id=NEW.assigned_user_id) OR EXISTS(SELECT 1 FROM public.users WHERE id=NEW.assigned_user_id AND coalesce(permissions,'[]'::jsonb)?'company.project-only') THEN RETURN NULL;END IF;
 IF TG_OP='UPDATE' AND public.company_project_background_blocked(to_jsonb(OLD)) THEN RETURN NULL;END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION tozon_internal.quarantine_project_task() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION tozon_internal.quarantine_project_task() TO service_role;
CREATE TRIGGER company_task_quarantine BEFORE INSERT OR UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION tozon_internal.quarantine_project_task();
