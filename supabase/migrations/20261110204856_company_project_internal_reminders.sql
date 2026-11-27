CREATE TABLE public.company_project_reminder_settings(
 company_project_id uuid PRIMARY KEY REFERENCES public.company_projects(id),enabled boolean NOT NULL DEFAULT false,
 lead_days integer NOT NULL DEFAULT 3 CHECK(lead_days BETWEEN 0 AND 30),backlog_from date,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),updated_by integer REFERENCES public.users(id),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(NOT enabled OR backlog_from IS NOT NULL)
);
CREATE TABLE public.company_project_reminder_history(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,company_project_id uuid NOT NULL REFERENCES public.company_projects(id),actor_id integer NOT NULL REFERENCES public.users(id),revision integer NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.company_project_reminders(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_project_id uuid NOT NULL REFERENCES public.company_projects(id),user_id integer NOT NULL REFERENCES public.users(id),schedule_id integer NOT NULL REFERENCES public.deal_payment_schedules(id),reminder_kind text NOT NULL CHECK(reminder_kind IN ('DUE','OVERDUE')),due_date date NOT NULL,is_read boolean NOT NULL DEFAULT false,read_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_project_id,user_id,schedule_id,reminder_kind,due_date)
);
CREATE INDEX company_reminders_recipient ON public.company_project_reminders(company_project_id,user_id,id);
ALTER TABLE public.company_project_reminder_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_project_reminder_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_project_reminders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_project_reminder_settings,public.company_project_reminder_history,public.company_project_reminders FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON public.company_project_reminder_settings,public.company_project_reminders TO service_role;
GRANT SELECT,INSERT ON public.company_project_reminder_history TO service_role;
GRANT USAGE ON SEQUENCE public.company_project_reminder_history_id_seq TO service_role;

CREATE FUNCTION tozon_internal.authorize_reminder_admin(p_actor integer) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
 PERFORM 1 FROM public.users WHERE id=p_actor AND role='ADMIN' AND is_active=1 AND NOT(coalesce(permissions,'[]'::jsonb)?'company.project-only') AND (NOT(coalesce(permissions,'[]'::jsonb)?'access.v2') OR coalesce(permissions,'[]'::jsonb)?&ARRAY['settings.view','settings.manage','users.view','users.manage']) FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'REMINDER_ADMIN_REQUIRED' USING ERRCODE='42501';END IF;
END $fn$;
REVOKE ALL ON FUNCTION tozon_internal.authorize_reminder_admin(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION tozon_internal.authorize_reminder_admin(integer) TO service_role;
CREATE FUNCTION public.company_project_reminder_configuration(p_actor integer,p_project uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE r public.company_project_reminder_settings;
BEGIN
 PERFORM tozon_internal.authorize_reminder_admin(p_actor);
 IF NOT EXISTS(SELECT 1 FROM public.company_projects WHERE id=p_project) THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND' USING ERRCODE='P0002';END IF;
 SELECT * INTO r FROM public.company_project_reminder_settings WHERE company_project_id=p_project;
 RETURN CASE WHEN FOUND THEN to_jsonb(r) ELSE jsonb_build_object('company_project_id',p_project,'enabled',false,'lead_days',3,'backlog_from',NULL,'revision',0) END;
END $fn$;
CREATE FUNCTION public.save_company_project_reminders(p_actor integer,p_project uuid,p_revision integer,p_enabled boolean,p_lead_days integer,p_backlog_from date)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE r public.company_project_reminder_settings;
BEGIN
 PERFORM tozon_internal.authorize_reminder_admin(p_actor);
 PERFORM 1 FROM public.company_projects WHERE id=p_project FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND' USING ERRCODE='P0002';END IF;
 IF p_revision IS NULL OR p_revision<0 OR p_enabled IS NULL OR p_lead_days IS NULL OR p_lead_days NOT BETWEEN 0 AND 30 OR (p_enabled AND (p_backlog_from IS NULL OR p_backlog_from>(now() AT TIME ZONE 'Asia/Dushanbe')::date)) THEN RAISE EXCEPTION 'INVALID_REMINDER_SETTINGS' USING ERRCODE='22023';END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('project-reminder-settings:'||p_project::text,0));
 SELECT * INTO r FROM public.company_project_reminder_settings WHERE company_project_id=p_project FOR UPDATE;
 IF coalesce(r.revision,0)<>p_revision THEN RAISE EXCEPTION 'STALE_REMINDER_SETTINGS' USING ERRCODE='40001';END IF;
 INSERT INTO public.company_project_reminder_settings(company_project_id,enabled,lead_days,backlog_from,revision,updated_by)
 VALUES(p_project,p_enabled,p_lead_days,p_backlog_from,p_revision+1,p_actor)
 ON CONFLICT(company_project_id) DO UPDATE SET enabled=excluded.enabled,lead_days=excluded.lead_days,backlog_from=excluded.backlog_from,revision=excluded.revision,updated_by=p_actor,updated_at=now() RETURNING * INTO r;
 INSERT INTO public.company_project_reminder_history(company_project_id,actor_id,revision,data) VALUES(p_project,p_actor,r.revision,to_jsonb(r));
 RETURN to_jsonb(r);
END $fn$;
REVOKE ALL ON FUNCTION public.company_project_reminder_configuration(integer,uuid),public.save_company_project_reminders(integer,uuid,integer,boolean,integer,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.company_project_reminder_configuration(integer,uuid),public.save_company_project_reminders(integer,uuid,integer,boolean,integer,date) TO service_role;

-- One project per refresh. Only service_role can call this background entry point.
CREATE FUNCTION public.refresh_company_project_reminders(p_project uuid)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE settings public.company_project_reminder_settings;today date:=(now() AT TIME ZONE 'Asia/Dushanbe')::date;added integer;
BEGIN
 SELECT * INTO settings FROM public.company_project_reminder_settings WHERE company_project_id=p_project AND enabled FOR SHARE;
 IF NOT FOUND THEN RETURN 0;END IF;
 WITH own_schedules AS MATERIALIZED (
 SELECT s.id,s.due_date::date AS due_date FROM public.deal_payment_schedules s JOIN public.deals d ON d.id=s.deal_id JOIN public.units u ON u.id=d.unit_id JOIN public.floors f ON f.id=u.floor_id JOIN public.sections sec ON sec.id=f.section_id JOIN public.buildings b ON b.id=sec.building_id JOIN public.projects c ON c.id=b.project_id JOIN public.company_project_complexes cp ON cp.complex_id=c.id JOIN public.company_project_leads cl ON cl.lead_id=d.lead_id
 WHERE d.company_project_id=p_project AND cp.company_project_id=p_project AND cl.company_project_id=p_project AND d.status='SIGNED' AND s.status NOT IN ('PAID','CANCELLED') AND s.amount_minor>coalesce(s.paid_amount_minor,0) AND u.archived_at IS NULL AND f.archived_at IS NULL AND sec.archived_at IS NULL AND b.archived_at IS NULL AND c.archived_at IS NULL
 )
 INSERT INTO public.company_project_reminders(company_project_id,user_id,schedule_id,reminder_kind,due_date)
 SELECT p_project,a.user_id,s.id,CASE WHEN s.due_date<today THEN 'OVERDUE' ELSE 'DUE' END,s.due_date
 FROM own_schedules s JOIN public.company_workspace_access a ON a.company_project_id=p_project JOIN public.company_workspace_users w ON w.user_id=a.user_id JOIN public.users x ON x.id=a.user_id
 WHERE a.enabled AND w.enabled AND x.is_active=1 AND coalesce(x.permissions,'[]'::jsonb)?'company.project-only' AND a.sections@>ARRAY['deals.view','finance.payments']::text[] AND s.due_date BETWEEN settings.backlog_from AND today+settings.lead_days
 ON CONFLICT(company_project_id,user_id,schedule_id,reminder_kind,due_date) DO NOTHING;
 GET DIAGNOSTICS added=ROW_COUNT;RETURN added;
END $fn$;
REVOKE ALL ON FUNCTION public.refresh_company_project_reminders(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_company_project_reminders(uuid) TO service_role;

CREATE FUNCTION public.read_company_project_reminders(p_actor integer,p_project uuid,p_after text DEFAULT '',p_limit integer DEFAULT 50,p_record uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
DECLARE rows jsonb;today date:=(now() AT TIME ZONE 'Asia/Dushanbe')::date;
BEGIN
 PERFORM public.read_company_project_workspace(p_actor,p_project,'deals',NULL,'',1);
 PERFORM 1 FROM public.company_workspace_access a JOIN public.company_workspace_users w ON w.user_id=a.user_id JOIN public.users x ON x.id=a.user_id WHERE a.user_id=p_actor AND a.company_project_id=p_project AND a.enabled AND w.enabled AND x.is_active=1 AND a.sections@>ARRAY['deals.view','finance.payments']::text[] AND coalesce(x.permissions,'[]'::jsonb)?'company.project-only' FOR SHARE OF a,w,x;
 IF NOT FOUND THEN RAISE EXCEPTION 'REMINDER_ACCESS_DENIED' USING ERRCODE='42501';END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR length(coalesce(p_after,''))>40 THEN RAISE EXCEPTION 'INVALID_REMINDER_PAGE' USING ERRCODE='22023';END IF;
 PERFORM public.refresh_company_project_reminders(p_project);
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.id),'[]'::jsonb) INTO rows FROM (
 SELECT n.id,n.reminder_kind,n.is_read,n.due_date,d.contract_number,l.full_name AS client_name,u.unit_number,c.name AS complex_name,s.amount_minor-coalesce(s.paid_amount_minor,0) AS remaining_minor,d.currency
 FROM public.company_project_reminders n JOIN public.company_project_reminder_settings cfg ON cfg.company_project_id=n.company_project_id AND cfg.enabled JOIN public.deal_payment_schedules s ON s.id=n.schedule_id JOIN public.deals d ON d.id=s.deal_id JOIN public.units u ON u.id=d.unit_id JOIN public.floors f ON f.id=u.floor_id JOIN public.sections sec ON sec.id=f.section_id JOIN public.buildings b ON b.id=sec.building_id JOIN public.projects c ON c.id=b.project_id JOIN public.company_project_complexes cp ON cp.complex_id=c.id JOIN public.company_project_leads cl ON cl.lead_id=d.lead_id JOIN public.leads l ON l.id=d.lead_id
 WHERE n.company_project_id=p_project AND n.user_id=p_actor AND d.company_project_id=p_project AND cp.company_project_id=p_project AND cl.company_project_id=p_project AND d.status='SIGNED' AND s.status NOT IN ('PAID','CANCELLED') AND s.amount_minor>coalesce(s.paid_amount_minor,0) AND n.due_date=s.due_date::date AND n.due_date BETWEEN cfg.backlog_from AND today+cfg.lead_days AND n.reminder_kind=CASE WHEN n.due_date<today THEN 'OVERDUE' ELSE 'DUE' END AND u.archived_at IS NULL AND f.archived_at IS NULL AND sec.archived_at IS NULL AND b.archived_at IS NULL AND c.archived_at IS NULL AND (p_record IS NULL OR n.id=p_record) AND n.id::text>coalesce(p_after,'') ORDER BY n.id LIMIT p_limit+1
 ) q;
 IF p_record IS NOT NULL AND jsonb_array_length(rows)=0 THEN RAISE EXCEPTION 'REMINDER_NOT_FOUND' USING ERRCODE='P0002';END IF;
 RETURN jsonb_build_object('records',CASE WHEN jsonb_array_length(rows)>p_limit THEN rows-p_limit ELSE rows END,'has_more',jsonb_array_length(rows)>p_limit,'project_id',p_project);
END $fn$;
CREATE FUNCTION public.ack_company_project_reminder(p_actor integer,p_project uuid,p_record uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
BEGIN
 PERFORM public.read_company_project_reminders(p_actor,p_project,'',1,p_record);
 UPDATE public.company_project_reminders SET is_read=true,read_at=coalesce(read_at,now()) WHERE id=p_record AND user_id=p_actor AND company_project_id=p_project;
 RETURN jsonb_build_object('id',p_record,'is_read',true);
END $fn$;
REVOKE ALL ON FUNCTION public.read_company_project_reminders(integer,uuid,text,integer,uuid),public.ack_company_project_reminder(integer,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_company_project_reminders(integer,uuid,text,integer,uuid),public.ack_company_project_reminder(integer,uuid,uuid) TO service_role;
