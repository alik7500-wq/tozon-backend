-- Stage 1: preparation registry, not an operational isolation switch.
-- Existing projects are residential complexes; company_projects are partner projects.
-- No existing financial/customer records, users or settings are updated here.
CREATE TABLE public.crm_companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_-]{0,39}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.company_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.crm_companies(id) ON DELETE RESTRICT,
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_-]{0,39}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  location text NOT NULL DEFAULT '' CHECK (length(location)<=300),
  director_name text NOT NULL DEFAULT '' CHECK (length(director_name)<=200),
  director_authority text NOT NULL DEFAULT '' CHECK (length(director_authority)<=1000),
  isolation_state text NOT NULL DEFAULT 'PREPARATION' CHECK (isolation_state = 'PREPARATION'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,code)
);
CREATE TABLE public.company_project_partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_project_id uuid NOT NULL REFERENCES public.company_projects(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  share_percent numeric(5,2) NOT NULL CHECK (share_percent>0 AND share_percent<=100)
);
CREATE UNIQUE INDEX company_project_partner_name ON public.company_project_partners(company_project_id,lower(btrim(name)));
CREATE TABLE public.company_project_memberships (
  company_project_id uuid NOT NULL REFERENCES public.company_projects(id) ON DELETE RESTRICT,
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  project_role text NOT NULL CHECK (project_role IN ('PARTNER','DIRECTOR','ACCOUNTANT','MANAGER','CASHIER','WAREHOUSE')),
  access_state text NOT NULL DEFAULT 'PLANNED' CHECK (access_state='PLANNED'),
  PRIMARY KEY(company_project_id,user_id)
);
CREATE INDEX company_project_memberships_user ON public.company_project_memberships(user_id);
CREATE TABLE public.company_project_complexes (
  complex_id integer PRIMARY KEY REFERENCES public.projects(id) ON DELETE RESTRICT,
  company_project_id uuid NOT NULL REFERENCES public.company_projects(id) ON DELETE RESTRICT
);
CREATE INDEX company_project_complexes_parent ON public.company_project_complexes(company_project_id);
CREATE TABLE public.company_project_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_project_id uuid NOT NULL REFERENCES public.company_projects(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  actor_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_project_id,revision)
);
CREATE INDEX company_project_history_actor ON public.company_project_history(actor_id);

-- Server-only tables. Existing custom CRM JWTs are not Supabase Auth identities.
-- Do not add a generic authenticated USING(true) policy.
DO $block$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['crm_companies','company_projects','company_project_partners','company_project_memberships','company_project_complexes','company_project_history'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated',t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO service_role',t);
  END LOOP;
END $block$;

-- SECURITY INVOKER deliberately: only the server service role may execute it.
CREATE FUNCTION public.save_company_project_draft(p_project_id uuid,p_expected_revision integer,p_payload jsonb,p_actor_id integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $function$
DECLARE
  v_id uuid; v_company uuid; v_revision integer; v_existing jsonb; v_result jsonb;
  v_partners jsonb; v_members jsonb; v_complexes jsonb;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=p_actor_id AND role='ADMIN' AND is_active=1) THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED' USING ERRCODE='42501';
  END IF;
  SELECT id INTO STRICT v_company FROM public.crm_companies WHERE code='TOZON';
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR
     EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('code','name','location','director_name','director_authority','partners','members','complex_ids')) THEN
    RAISE EXCEPTION 'INVALID_PROJECT_PAYLOAD' USING ERRCODE='22023';
  END IF;
  v_partners:=coalesce(p_payload->'partners','[]'::jsonb);
  v_members:=coalesce(p_payload->'members','[]'::jsonb);
  v_complexes:=coalesce(p_payload->'complex_ids','[]'::jsonb);
  IF jsonb_typeof(v_partners) IS DISTINCT FROM 'array' OR jsonb_typeof(v_members) IS DISTINCT FROM 'array' OR jsonb_typeof(v_complexes) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'INVALID_PROJECT_ARRAYS' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(v_partners)>50 OR jsonb_array_length(v_members)>500 OR jsonb_array_length(v_complexes)>500 THEN
    RAISE EXCEPTION 'PROJECT_LIMIT_EXCEEDED' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(v_partners)>0 AND (
    EXISTS(SELECT 1 FROM jsonb_array_elements(v_partners) p WHERE jsonb_typeof(p->'share_percent') IS DISTINCT FROM 'number' OR jsonb_typeof(p->'name') IS DISTINCT FROM 'string' OR
      (p->>'share_percent')::numeric<=0 OR (p->>'share_percent')::numeric>100 OR (p->>'share_percent')::numeric<>round((p->>'share_percent')::numeric,2)) OR
    (SELECT sum((p->>'share_percent')::numeric) FROM jsonb_array_elements(v_partners) p) IS DISTINCT FROM 100::numeric
  ) THEN RAISE EXCEPTION 'PARTNER_SHARES_MUST_TOTAL_100' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_members) m LEFT JOIN public.users u ON u.id=(m->>'user_id')::integer WHERE u.id IS NULL OR u.is_active<>1 OR m->>'project_role' IS NULL) THEN
    RAISE EXCEPTION 'INACTIVE_OR_UNKNOWN_MEMBER' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(v_complexes) c LEFT JOIN public.projects p ON p.id=c::integer WHERE p.id IS NULL OR p.archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'UNKNOWN_OR_ARCHIVED_COMPLEX' USING ERRCODE='23514';
  END IF;
  IF p_project_id IS NULL THEN
    IF p_expected_revision IS NOT NULL THEN RAISE EXCEPTION 'STALE_PROJECT' USING ERRCODE='40001'; END IF;
    INSERT INTO public.company_projects(company_id,code,name) VALUES(v_company,p_payload->>'code',p_payload->>'name') RETURNING id,revision INTO v_id,v_revision;
  ELSE
    SELECT id,revision INTO v_id,v_revision FROM public.company_projects WHERE id=p_project_id AND company_id=v_company FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF p_expected_revision IS NULL OR p_expected_revision<>v_revision THEN RAISE EXCEPTION 'STALE_PROJECT' USING ERRCODE='40001'; END IF;
    v_revision:=v_revision+1;
  END IF;
  UPDATE public.company_projects SET code=p_payload->>'code',name=p_payload->>'name',location=coalesce(p_payload->>'location',''),
    director_name=coalesce(p_payload->>'director_name',''),director_authority=coalesce(p_payload->>'director_authority',''),
    revision=v_revision,updated_at=now() WHERE id=v_id;
  -- All replacements, complex assignment and audit entry commit together.
  DELETE FROM public.company_project_partners WHERE company_project_id=v_id;
  INSERT INTO public.company_project_partners(company_project_id,name,share_percent)
    SELECT v_id,btrim(p->>'name'),(p->>'share_percent')::numeric FROM jsonb_array_elements(v_partners) p;
  DELETE FROM public.company_project_memberships WHERE company_project_id=v_id;
  INSERT INTO public.company_project_memberships(company_project_id,user_id,project_role)
    SELECT v_id,(m->>'user_id')::integer,m->>'project_role' FROM jsonb_array_elements(v_members) m;
  DELETE FROM public.company_project_complexes WHERE company_project_id=v_id;
  INSERT INTO public.company_project_complexes(company_project_id,complex_id)
    SELECT v_id,c::integer FROM jsonb_array_elements_text(v_complexes) c;
  SELECT to_jsonb(p) || jsonb_build_object('partners',v_partners,'members',v_members,'complex_ids',v_complexes) INTO v_result FROM public.company_projects p WHERE id=v_id;
  INSERT INTO public.company_project_history(company_project_id,revision,actor_id,data) VALUES(v_id,v_revision,p_actor_id,v_result);
  RETURN v_result;
END $function$;
REVOKE ALL ON FUNCTION public.save_company_project_draft(uuid,integer,jsonb,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_company_project_draft(uuid,integer,jsonb,integer) TO service_role;

INSERT INTO public.crm_companies(code,name) VALUES('TOZON','ООО «ТОЗОН»');
INSERT INTO public.company_projects(company_id,code,name,location)
SELECT c.id,p.code,p.name,p.location FROM public.crm_companies c CROSS JOIN (VALUES
 ('TOZON_PLAZA','Tozon Plaza','Худжанд'),('TOZON_TOWER','Tozon Tower','Худжанд'),
 ('TOZON_GARDEN','Tozon Garden','Джаббор-Расуловский район'),('TOZON_RESIDENSE','Tozon Residense','Канибадам'),
 ('KRISTALL','ЖК Кристалл','Худжанд')
) p(code,name,location) WHERE c.code='TOZON';
-- Names of partners/directors and user assignments are deliberately not guessed.
-- Existing complexes are not auto-matched by name or numeric IDs.
