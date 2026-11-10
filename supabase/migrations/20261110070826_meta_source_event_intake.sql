BEGIN;
CREATE TABLE public.meta_source_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE CHECK(event_key ~ '^[0-9a-f]{64}$'),
  source_id uuid NOT NULL REFERENCES public.meta_project_sources(id),
  connection_id uuid NOT NULL REFERENCES public.meta_source_connections(id),
  project_id bigint REFERENCES public.projects(id),
  channel text NOT NULL CHECK(channel IN ('INSTAGRAM_MESSAGES','INSTAGRAM_COMMENTS','FACEBOOK_MESSAGES','FACEBOOK_COMMENTS','FACEBOOK_FORM')),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=40000),
  status text NOT NULL CHECK(status IN ('UNASSIGNED','QUEUED','PROCESSING','RETRY','DONE','NEEDS_REVIEW','FAILED','PAUSED')),
  lead_id bigint REFERENCES public.leads(id),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX ON public.meta_source_events(connection_id,received_at DESC);
CREATE INDEX ON public.meta_source_events(project_id,received_at DESC);
CREATE INDEX ON public.meta_source_events(next_attempt_at) WHERE status IN ('QUEUED','RETRY','PROCESSING');
ALTER TABLE public.meta_source_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meta_source_events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.meta_source_events TO service_role;
CREATE POLICY service_only ON public.meta_source_events TO service_role USING(true) WITH CHECK(true);

CREATE FUNCTION public.meta_contact_phone(p_value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=public AS $$
 WITH cleaned AS(SELECT regexp_replace(p_value,'[^0-9]','','g') AS n),
 normalized AS(SELECT CASE WHEN left(n,2)='00' THEN substr(n,3) ELSE n END AS n FROM cleaned)
 SELECT CASE WHEN length(n)=9 THEN '992'||n ELSE n END FROM normalized;
$$;

CREATE FUNCTION public.meta_source_owner_active(p_owner bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM public.users u WHERE u.id=p_owner AND u.is_active::text IN ('1','true') AND u.role IN ('ADMIN','DIRECTOR')
   AND (NOT coalesce(to_jsonb(u)->'permissions','[]'::jsonb) ? 'access.v2'
     OR (coalesce(to_jsonb(u)->'permissions','[]'::jsonb) ? 'automation.view' AND coalesce(to_jsonb(u)->'permissions','[]'::jsonb) ? 'automation.manage')));
$$;

CREATE FUNCTION public.enqueue_meta_source_events(p_events jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE v_event jsonb; v_source public.meta_project_sources%rowtype; v_count integer:=0; v_rows integer; v_project bigint;
BEGIN
 IF p_events IS NULL OR jsonb_typeof(p_events)<>'array' OR jsonb_array_length(p_events)>200 THEN RAISE EXCEPTION 'Invalid events'; END IF;
 FOR v_event IN SELECT value FROM jsonb_array_elements(p_events) LOOP
   IF coalesce(v_event->>'event_key','') !~ '^[0-9a-f]{64}$' OR jsonb_typeof(v_event->'payload') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid event'; END IF;
   SELECT s.* INTO v_source FROM public.meta_project_sources s JOIN public.meta_source_connections c ON c.id=s.connection_id
     WHERE s.channel=v_event->>'channel' AND s.external_id=v_event->>'external_id' AND s.available AND c.status='connected'
       AND (v_event->>'page_id' IS NULL OR s.page_id=v_event->>'page_id')
       AND (c.token_expires_at IS NULL OR c.token_expires_at>now()) AND public.meta_source_owner_active(c.owner_user_id)
     FOR SHARE OF c,s;
   IF NOT FOUND THEN CONTINUE; END IF;
   IF v_source.channel='FACEBOOK_FORM' AND (coalesce(v_event->'payload'->>'leadgen_id','') !~ '^[0-9]{1,30}$'
     OR v_event->'payload'->>'form_id' IS DISTINCT FROM v_source.external_id) THEN RAISE EXCEPTION 'Invalid form'; END IF;
   SELECT id INTO v_project FROM public.projects WHERE id=v_source.project_id AND archived_at IS NULL;
   INSERT INTO public.meta_source_events(event_key,source_id,connection_id,project_id,channel,payload,status,processed_at)
     VALUES(v_event->>'event_key',v_source.id,v_source.connection_id,v_project,v_source.channel,v_event->'payload',
       CASE WHEN v_project IS NULL THEN 'UNASSIGNED' WHEN v_source.channel='FACEBOOK_FORM' THEN 'QUEUED' ELSE 'DONE' END,
       CASE WHEN v_project IS NOT NULL AND v_source.channel<>'FACEBOOK_FORM' THEN now() END)
     ON CONFLICT(event_key) DO NOTHING;
   GET DIAGNOSTICS v_rows=ROW_COUNT; v_count:=v_count+v_rows;
 END LOOP;
 RETURN v_count;
END $$;

CREATE FUNCTION public.assign_meta_source_event(p_owner bigint,p_event uuid,p_expected_project bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE v_connection uuid; v_rows integer;
BEGIN
 SELECT id INTO v_connection FROM public.meta_source_connections WHERE owner_user_id=p_owner AND status='connected'
   AND (token_expires_at IS NULL OR token_expires_at>now()) AND public.meta_source_owner_active(p_owner) FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE public.meta_source_events e SET project_id=coalesce(e.project_id,s.project_id),attempts=0,
   error_code=NULL,lease_token=NULL,lease_until=NULL,next_attempt_at=now(),
   status=CASE WHEN e.channel='FACEBOOK_FORM' THEN 'QUEUED' ELSE 'DONE' END,
   processed_at=CASE WHEN e.channel<>'FACEBOOK_FORM' THEN now() END
   FROM public.meta_project_sources s,public.projects p WHERE e.id=p_event AND e.status IN ('UNASSIGNED','PAUSED','FAILED','NEEDS_REVIEW')
     AND e.connection_id=v_connection AND s.id=e.source_id AND s.available AND p.id=s.project_id AND p.archived_at IS NULL
     AND s.project_id=p_expected_project AND (e.project_id IS NULL OR e.project_id=s.project_id);
 GET DIAGNOSTICS v_rows=ROW_COUNT; RETURN v_rows=1;
END $$;

CREATE FUNCTION public.claim_meta_form_events(p_limit integer DEFAULT 5) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE v_result jsonb;
BEGIN
 UPDATE public.meta_source_events SET status='FAILED',error_code='RETRY_LIMIT',lease_token=NULL,lease_until=NULL
   WHERE status IN ('PROCESSING','RETRY') AND attempts>=5 AND (lease_until IS NULL OR lease_until<now());
 WITH candidates AS (
   SELECT e.id FROM public.meta_source_events e JOIN public.meta_project_sources s ON s.id=e.source_id
     JOIN public.meta_source_connections c ON c.id=e.connection_id JOIN public.projects p ON p.id=e.project_id
   WHERE e.channel='FACEBOOK_FORM' AND e.attempts<5 AND e.project_id IS NOT NULL AND p.archived_at IS NULL
     AND ((e.status IN ('QUEUED','RETRY') AND e.next_attempt_at<=now()) OR (e.status='PROCESSING' AND e.lease_until<now()))
     AND s.available AND c.status='connected' AND s.encrypted_access_token IS NOT NULL
     AND (c.token_expires_at IS NULL OR c.token_expires_at>now()) AND public.meta_source_owner_active(c.owner_user_id)
   ORDER BY e.received_at LIMIT greatest(1,least(coalesce(p_limit,5),5)) FOR UPDATE OF e SKIP LOCKED
 ), claimed AS (
   UPDATE public.meta_source_events e SET status='PROCESSING',attempts=e.attempts+1,
     lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes'
   FROM candidates k WHERE e.id=k.id RETURNING e.*
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'lease_token',e.lease_token,'payload',e.payload,
     'external_id',s.external_id,'encrypted_access_token',s.encrypted_access_token)), '[]'::jsonb)
   INTO v_result FROM claimed e JOIN public.meta_project_sources s ON s.id=e.source_id;
 RETURN v_result;
END $$;

CREATE FUNCTION public.fail_meta_form_event(p_event uuid,p_lease uuid,p_code text,p_review boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE v_rows integer;
BEGIN
 IF p_code NOT IN ('PHONE_MISSING_OR_INVALID','FORM_ID_MISMATCH','META_FORM_RETRIEVAL_FAILED') THEN RAISE EXCEPTION 'Invalid error code'; END IF;
 UPDATE public.meta_source_events SET status=CASE WHEN p_review THEN 'NEEDS_REVIEW' WHEN attempts>=5 THEN 'FAILED' ELSE 'RETRY' END,
   error_code=p_code,lease_token=NULL,lease_until=NULL,next_attempt_at=now()+make_interval(secs=>least(3600,(power(2,attempts)*15)::integer))
   WHERE id=p_event AND lease_token=p_lease AND status='PROCESSING' AND lease_until>now();
 GET DIAGNOSTICS v_rows=ROW_COUNT; RETURN v_rows=1;
END $$;

CREATE FUNCTION public.complete_meta_form_event(p_event uuid,p_lease uuid,p_form jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE v_event public.meta_source_events%rowtype; v_connection public.meta_source_connections%rowtype;
 v_phone text; v_lead bigint; v_count integer; v_name text; v_now text; v_note text;
BEGIN
 -- Lock order matches disconnect: connection first, then the event.
 SELECT c.* INTO v_connection FROM public.meta_source_connections c JOIN public.meta_source_events e ON e.connection_id=c.id
   WHERE e.id=p_event FOR UPDATE OF c;
 SELECT * INTO v_event FROM public.meta_source_events WHERE id=p_event AND lease_token=p_lease AND status='PROCESSING' AND lease_until>now() FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF v_connection.status<>'connected' OR (v_connection.token_expires_at IS NOT NULL AND v_connection.token_expires_at<=now())
   OR NOT public.meta_source_owner_active(v_connection.owner_user_id)
   OR NOT EXISTS(SELECT 1 FROM public.meta_project_sources WHERE id=v_event.source_id AND available)
   OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=v_event.project_id AND archived_at IS NULL) THEN
   UPDATE public.meta_source_events SET status='PAUSED',error_code='SOURCE_UNAVAILABLE',lease_token=NULL,lease_until=NULL WHERE id=p_event;
   RETURN false;
 END IF;
 IF v_event.channel<>'FACEBOOK_FORM' THEN RAISE EXCEPTION 'Not a form event'; END IF;
 v_phone:=public.meta_contact_phone(coalesce(p_form->>'phone',''));
 v_name:=left(coalesce(p_form->>'full_name',''),200);
 IF v_phone !~ '^[1-9][0-9]{6,14}$' OR v_name='' THEN RAISE EXCEPTION 'Invalid form contact'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('intake-phone:'||v_phone,0));
 -- No cross-project phone merge: partnerships and client records stay separate.
 SELECT count(*) INTO v_count FROM public.leads WHERE interested_project_id=v_event.project_id
   AND (public.meta_contact_phone(phone)=v_phone OR public.meta_contact_phone(secondary_phone)=v_phone) AND archived_at IS NULL;
 IF v_count>1 OR (v_count=0 AND EXISTS(SELECT 1 FROM public.leads WHERE interested_project_id=v_event.project_id
   AND (public.meta_contact_phone(phone)=v_phone OR public.meta_contact_phone(secondary_phone)=v_phone) AND archived_at IS NOT NULL)) THEN
   UPDATE public.meta_source_events SET status='NEEDS_REVIEW',error_code='CONTACT_REVIEW',lease_token=NULL,lease_until=NULL WHERE id=p_event;
   RETURN true;
 END IF;
 SELECT id INTO v_lead FROM public.leads WHERE interested_project_id=v_event.project_id AND archived_at IS NULL
   AND (public.meta_contact_phone(phone)=v_phone OR public.meta_contact_phone(secondary_phone)=v_phone) LIMIT 1 FOR UPDATE;
 v_now:=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 v_note:='[Facebook Lead Ads] '||v_name||E'\n'||left(coalesce(p_form->>'notes',''),4000);
 IF v_lead IS NULL THEN
   INSERT INTO public.leads(full_name,phone,source,status,notes,responsible_user_id,interested_project_id,created_at,updated_at)
   VALUES(v_name,'+'||v_phone,'FACEBOOK','NEW',v_note,NULL,v_event.project_id,v_now,v_now) RETURNING id INTO v_lead;
 ELSE
   INSERT INTO public.lead_notes(lead_id,author_user_id,body,created_at) VALUES(v_lead,v_connection.owner_user_id,v_note,v_now);
 END IF;
 UPDATE public.meta_source_events SET status='DONE',lead_id=v_lead,processed_at=now(),lease_token=NULL,lease_until=NULL,error_code=NULL WHERE id=p_event;
 RETURN true;
END $$;

-- Disconnect cannot be undone by a worker that fetched its token earlier.
CREATE OR REPLACE FUNCTION public.disconnect_meta_source_connection(p_owner bigint)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE v_connection uuid;
BEGIN
 SELECT id INTO v_connection FROM public.meta_source_connections WHERE owner_user_id=p_owner FOR UPDATE;
 UPDATE public.meta_source_connections SET status='disconnected',encrypted_access_token=NULL,updated_at=now() WHERE id=v_connection;
 UPDATE public.meta_project_sources SET available=false,encrypted_access_token=NULL,project_id=NULL,updated_at=now() WHERE connection_id=v_connection;
 UPDATE public.meta_source_oauth_states SET cancelled_at=now() WHERE owner_user_id=p_owner;
 UPDATE public.meta_source_events SET status='PAUSED',error_code='SOURCE_DISCONNECTED',lease_token=NULL,lease_until=NULL
   WHERE connection_id=v_connection AND status IN ('UNASSIGNED','QUEUED','RETRY','PROCESSING');
END $$;

REVOKE ALL ON FUNCTION public.meta_contact_phone(text),public.meta_source_owner_active(bigint),public.enqueue_meta_source_events(jsonb),
 public.assign_meta_source_event(bigint,uuid,bigint),public.claim_meta_form_events(integer),
 public.fail_meta_form_event(uuid,uuid,text,boolean),public.complete_meta_form_event(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.meta_contact_phone(text),public.meta_source_owner_active(bigint),public.enqueue_meta_source_events(jsonb),
 public.assign_meta_source_event(bigint,uuid,bigint),public.claim_meta_form_events(integer),
 public.fail_meta_form_event(uuid,uuid,text,boolean),public.complete_meta_form_event(uuid,uuid,jsonb) TO service_role;
COMMIT;
