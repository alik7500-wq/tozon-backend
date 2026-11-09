BEGIN;

-- One installation is one company database. CRM user ownership is checked by
-- server routes and invoker RPCs. Do not use these tables in a shared tenant DB
-- until tenant_id and tenant authorization have been added throughout the API.
CREATE TABLE public.meta_source_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id bigint NOT NULL UNIQUE REFERENCES public.users(id),
  meta_user_id text NOT NULL CHECK (meta_user_id ~ '^[0-9]+$'),
  display_name text NOT NULL,
  encrypted_access_token text,
  token_expires_at timestamptz,
  status text NOT NULL CHECK (status IN ('connected','disconnected')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'connected' OR encrypted_access_token LIKE 'v1.%')
);
CREATE TABLE public.meta_source_oauth_states (
  state_digest text PRIMARY KEY CHECK (state_digest ~ '^[0-9a-f]{64}$'),
  owner_user_id bigint NOT NULL REFERENCES public.users(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  cancelled_at timestamptz
);
CREATE TABLE public.meta_project_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES public.meta_source_connections(id),
  channel text NOT NULL CHECK (channel IN ('INSTAGRAM_MESSAGES','INSTAGRAM_COMMENTS','FACEBOOK_MESSAGES','FACEBOOK_COMMENTS','FACEBOOK_FORM')),
  external_id text NOT NULL CHECK (external_id ~ '^[0-9]+$'),
  page_id text NOT NULL CHECK (page_id ~ '^[0-9]+$'),
  name text NOT NULL,
  username text,
  encrypted_access_token text CHECK (encrypted_access_token IS NULL OR encrypted_access_token LIKE 'v1.%'),
  project_id bigint REFERENCES public.projects(id),
  available boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_id)
);
CREATE INDEX ON public.meta_project_sources(connection_id);
CREATE INDEX ON public.meta_project_sources(project_id) WHERE project_id IS NOT NULL;

ALTER TABLE public.meta_source_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_source_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_project_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meta_source_connections, public.meta_source_oauth_states, public.meta_project_sources FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meta_source_connections, public.meta_source_oauth_states, public.meta_project_sources TO service_role;
CREATE POLICY service_only ON public.meta_source_connections TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_only ON public.meta_source_oauth_states TO service_role USING (true) WITH CHECK (true);
CREATE POLICY service_only ON public.meta_project_sources TO service_role USING (true) WITH CHECK (true);

CREATE FUNCTION public.sync_meta_source_catalogue(
  p_owner bigint, p_meta_user text, p_name text, p_token text,
  p_expires timestamptz, p_assets jsonb, p_state_digest text
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_connection uuid; v_asset jsonb; v_id uuid; v_previous_user text;
BEGIN
  IF p_assets IS NULL OR jsonb_typeof(p_assets) <> 'array' OR jsonb_array_length(p_assets) > 10000 OR p_token IS NULL OR p_token NOT LIKE 'v1.%' THEN
    RAISE EXCEPTION 'Invalid catalogue';
  END IF;
  SELECT meta_user_id INTO v_previous_user FROM public.meta_source_connections WHERE owner_user_id = p_owner FOR UPDATE;
  INSERT INTO public.meta_source_connections(owner_user_id,meta_user_id,display_name,encrypted_access_token,token_expires_at,status)
  VALUES(p_owner,p_meta_user,p_name,p_token,p_expires,'connected')
  ON CONFLICT(owner_user_id) DO UPDATE SET meta_user_id=excluded.meta_user_id,display_name=excluded.display_name,
    encrypted_access_token=excluded.encrypted_access_token,token_expires_at=excluded.token_expires_at,status='connected',updated_at=now()
  RETURNING id INTO v_connection;
  PERFORM state_digest FROM public.meta_source_oauth_states WHERE state_digest=p_state_digest
    AND owner_user_id=p_owner AND consumed_at IS NOT NULL AND cancelled_at IS NULL AND expires_at>now() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Authorization cancelled or expired'; END IF;
  DELETE FROM public.meta_source_oauth_states WHERE state_digest=p_state_digest;
  UPDATE public.meta_project_sources SET available=false,encrypted_access_token=NULL,
    project_id=CASE WHEN v_previous_user IS DISTINCT FROM p_meta_user THEN NULL ELSE project_id END,
    updated_at=now() WHERE connection_id=v_connection;
  FOR v_asset IN SELECT value FROM jsonb_array_elements(p_assets) LOOP
    v_id := NULL;
    INSERT INTO public.meta_project_sources(connection_id,channel,external_id,page_id,name,username,encrypted_access_token)
    VALUES(v_connection,v_asset->>'channel',v_asset->>'external_id',v_asset->>'page_id',v_asset->>'name',v_asset->>'username',v_asset->>'encrypted_access_token')
    ON CONFLICT(channel,external_id) DO UPDATE SET
      page_id=excluded.page_id,name=excluded.name,username=excluded.username,
      encrypted_access_token=excluded.encrypted_access_token,available=true,updated_at=now()
    WHERE meta_project_sources.connection_id=v_connection RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Source belongs to another connection'; END IF;
  END LOOP;
END $$;

CREATE FUNCTION public.bind_meta_project_source(p_owner bigint,p_source uuid,p_project bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_connection uuid; v_count integer;
BEGIN
  SELECT id INTO v_connection FROM public.meta_source_connections
    WHERE owner_user_id=p_owner AND status='connected'
      AND (token_expires_at IS NULL OR token_expires_at>now()) FOR UPDATE;
  IF v_connection IS NULL THEN RETURN false; END IF;
  IF p_project IS NOT NULL THEN
    PERFORM id FROM public.projects WHERE id=p_project AND archived_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
  END IF;
  UPDATE public.meta_project_sources SET project_id=p_project,updated_at=now()
    WHERE id=p_source AND connection_id=v_connection AND available;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count=1;
END $$;

CREATE FUNCTION public.disconnect_meta_source_connection(p_owner bigint)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_connection uuid;
BEGIN
  SELECT id INTO v_connection FROM public.meta_source_connections WHERE owner_user_id=p_owner FOR UPDATE;
  UPDATE public.meta_source_connections SET status='disconnected',encrypted_access_token=NULL,updated_at=now() WHERE id=v_connection;
  UPDATE public.meta_project_sources SET available=false,encrypted_access_token=NULL,project_id=NULL,updated_at=now() WHERE connection_id=v_connection;
  UPDATE public.meta_source_oauth_states SET cancelled_at=now() WHERE owner_user_id=p_owner;
END $$;
REVOKE ALL ON FUNCTION public.sync_meta_source_catalogue(bigint,text,text,text,timestamptz,jsonb,text),
  public.bind_meta_project_source(bigint,uuid,bigint),public.disconnect_meta_source_connection(bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_meta_source_catalogue(bigint,text,text,text,timestamptz,jsonb,text),
  public.bind_meta_project_source(bigint,uuid,bigint),public.disconnect_meta_source_connection(bigint) TO service_role;
COMMIT;
