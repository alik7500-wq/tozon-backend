BEGIN;
CREATE TABLE IF NOT EXISTS public.crm_user_presence (
 user_id integer PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
 last_login_at timestamptz, last_logout_at timestamptz,
 last_seen_at timestamptz NOT NULL DEFAULT now(),current_section text CHECK(length(current_section)<=80)
);
CREATE TABLE IF NOT EXISTS public.crm_activity_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
 actor_name text NOT NULL,actor_role text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('LOGIN','LOGOUT','VIEW','CREATE','UPDATE','DELETE','EXPORT')),
 resource text NOT NULL,entity_id text,summary text NOT NULL,
 http_method text,http_status integer,outcome text NOT NULL CHECK(outcome IN ('SUCCESS','FAILED')),
 changed_fields jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_activity_events_user_id_idx ON public.crm_activity_events(user_id,id DESC);
CREATE INDEX IF NOT EXISTS crm_activity_events_date_idx ON public.crm_activity_events(created_at DESC);
ALTER TABLE public.crm_user_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_activity_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_user_presence,public.crm_activity_events FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE public.crm_activity_events_id_seq FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON public.crm_user_presence TO service_role;
GRANT SELECT,INSERT ON public.crm_activity_events TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.crm_activity_events_id_seq TO service_role;
COMMIT;
