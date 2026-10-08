CREATE TABLE public.crm_document_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  version integer NOT NULL DEFAULT 1,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint
);
INSERT INTO public.crm_document_settings(id) VALUES (1);
CREATE TABLE public.crm_document_settings_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version integer NOT NULL, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by bigint
);
CREATE TABLE public.crm_document_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('CONTRACT','ACT','PKO','RKO','SCHEDULE','RESERVATION','OFFER','APARTMENT')),
  language text NOT NULL CHECK (language IN ('TJ','RU','UZ','EN')),
  scope text NOT NULL DEFAULT '*',
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  file_base64 text NOT NULL CHECK (length(file_base64) BETWEEN 1 AND 2796204),
  file_size integer NOT NULL CHECK (file_size BETWEEN 1 AND 2097152),
  created_at timestamptz NOT NULL DEFAULT now(), created_by bigint NOT NULL,
  active boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX crm_document_template_active_slot ON public.crm_document_templates(kind, language, scope) WHERE active;
CREATE INDEX crm_document_template_history ON public.crm_document_templates(kind, language, scope, created_at DESC);
ALTER TABLE public.crm_document_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_document_settings_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_document_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_document_settings, public.crm_document_settings_history, public.crm_document_templates FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.crm_document_settings, public.crm_document_templates TO service_role;
GRANT SELECT, INSERT ON public.crm_document_settings_history TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.crm_document_settings_history_id_seq TO service_role;

CREATE FUNCTION public.save_crm_document_settings(p_actor bigint, p_version integer, p_data jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE v_row public.crm_document_settings;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_actor AND role='ADMIN' AND is_active=1) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
 SELECT * INTO v_row FROM public.crm_document_settings WHERE id=1 FOR UPDATE;
 IF v_row.version <> p_version THEN RAISE EXCEPTION 'STALE_SETTINGS'; END IF;
 INSERT INTO public.crm_document_settings_history(version, data, created_by) VALUES(v_row.version,v_row.data,p_actor);
 UPDATE public.crm_document_settings SET data=p_data, version=version+1, updated_at=now(),updated_by=p_actor WHERE id=1 RETURNING * INTO v_row;
 RETURN to_jsonb(v_row);
END $$;
REVOKE ALL ON FUNCTION public.save_crm_document_settings(bigint,integer,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_crm_document_settings(bigint,integer,jsonb) TO service_role;

CREATE FUNCTION public.activate_crm_document_template(p_actor bigint, p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE v_row public.crm_document_templates;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=p_actor AND role='ADMIN' AND is_active=1) THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
 -- Serialize changes to slots, including activating a historical revision.
 PERFORM 1 FROM public.crm_document_settings WHERE id=1 FOR UPDATE;
 SELECT * INTO v_row FROM public.crm_document_templates WHERE id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'TEMPLATE_NOT_FOUND'; END IF;
 UPDATE public.crm_document_templates SET active=false WHERE kind=v_row.kind AND language=v_row.language AND scope=v_row.scope AND active;
 UPDATE public.crm_document_templates SET active=true WHERE id=p_id;
END $$;
REVOKE ALL ON FUNCTION public.activate_crm_document_template(bigint,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_crm_document_template(bigint,uuid) TO service_role;

-- Numbers for new documents only. Keep existing references, payment IDs and financial data intact.
ALTER TABLE public.payments ADD COLUMN document_number text;
ALTER TABLE public.expenses ADD COLUMN document_number text;
CREATE UNIQUE INDEX crm_payment_document_number ON public.payments(document_number) WHERE document_number IS NOT NULL;
CREATE UNIQUE INDEX crm_expense_document_number ON public.expenses(document_number) WHERE document_number IS NOT NULL;
CREATE SCHEMA IF NOT EXISTS tozon_internal;
REVOKE ALL ON SCHEMA tozon_internal FROM PUBLIC, anon, authenticated;
-- Legacy insert paths use both anon and service-role DB clients. This private trigger may
-- read only the numbering configuration; it is never callable as a Data API RPC.
CREATE FUNCTION tozon_internal.assign_document_number() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_data jsonb; v_pattern text; v_kind text; v_number text; v_project text := ''; v_unit text := ''; v_building text := '';
BEGIN
 IF TG_TABLE_NAME='deals' THEN v_kind:='CONTRACT'; ELSE v_kind:=CASE WHEN TG_TABLE_NAME='payments' THEN 'PKO' ELSE 'RKO' END; END IF;
 SELECT data INTO v_data FROM public.crm_document_settings WHERE id=1;
 v_pattern := v_data->'numbering'->>v_kind;
 IF v_pattern IS NULL OR v_pattern='' THEN RETURN NEW; END IF;
 IF length(v_pattern)>100 OR (position('{id}' in v_pattern)=0 AND position('{id4}' in v_pattern)=0) THEN RAISE EXCEPTION 'INVALID_NUMBER_PATTERN'; END IF;
 IF TG_TABLE_NAME='deals' THEN
   SELECT p.code,u.unit_number,b.name INTO v_project,v_unit,v_building FROM public.units u JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id JOIN public.projects p ON p.id=b.project_id WHERE u.id=NEW.unit_id;
 END IF;
 v_number:=replace(replace(replace(replace(replace(replace(v_pattern,'{id}',NEW.id::text),'{id4}', CASE WHEN length(NEW.id::text)<4 THEN lpad(NEW.id::text,4,'0') ELSE NEW.id::text END),'{year}',extract(year FROM COALESCE(CASE WHEN TG_TABLE_NAME='deals' THEN (to_jsonb(NEW)->>'deal_date')::date WHEN TG_TABLE_NAME='payments' THEN (to_jsonb(NEW)->>'payment_date')::date ELSE (to_jsonb(NEW)->>'expense_date')::date END, (now() AT TIME ZONE 'Asia/Dushanbe')::date))::text),'{project_code}',coalesce(v_project,'')),'{unit}',coalesce(v_unit,'')),'{building}',coalesce(v_building,''));
 IF v_number ~ '[{}]' OR length(v_number)>64 THEN RAISE EXCEPTION 'INVALID_NUMBER_PATTERN'; END IF;
 IF TG_TABLE_NAME='deals' THEN
   IF EXISTS(SELECT 1 FROM public.deals WHERE contract_number=v_number) THEN RAISE EXCEPTION 'NUMBER_ALREADY_EXISTS'; END IF;
   NEW.contract_number:=v_number;
 ELSE NEW.document_number:=v_number;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION tozon_internal.assign_document_number() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER crm_deal_number BEFORE INSERT ON public.deals FOR EACH ROW EXECUTE FUNCTION tozon_internal.assign_document_number();
CREATE TRIGGER crm_payment_number BEFORE INSERT ON public.payments FOR EACH ROW EXECUTE FUNCTION tozon_internal.assign_document_number();
CREATE TRIGGER crm_expense_number BEFORE INSERT ON public.expenses FOR EACH ROW EXECUTE FUNCTION tozon_internal.assign_document_number();
