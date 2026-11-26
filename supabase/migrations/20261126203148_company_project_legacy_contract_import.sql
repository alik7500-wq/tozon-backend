BEGIN;
ALTER TABLE public.deals ADD COLUMN source_import_batch_id uuid REFERENCES tozon_import.batches(id) ON DELETE RESTRICT;
ALTER TABLE public.deals DROP CONSTRAINT deals_contract_number_key;
CREATE UNIQUE INDEX deals_native_contract_number_unique ON public.deals(contract_number) WHERE source_import_batch_id IS NULL;
CREATE UNIQUE INDEX deals_import_contract_number_unique ON public.deals(source_import_batch_id,contract_number) WHERE source_import_batch_id IS NOT NULL;
CREATE FUNCTION tozon_internal.guard_imported_deal_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $guard$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.source_import_batch_id IS DISTINCT FROM OLD.source_import_batch_id THEN RAISE EXCEPTION 'IMPORT_SOURCE_IMMUTABLE' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF NEW.source_import_batch_id IS NOT NULL THEN
  IF current_user<>'postgres' OR current_setting('tozon.import_batch',true) IS DISTINCT FROM NEW.source_import_batch_id::text THEN
   RAISE EXCEPTION 'OWNER_IMPORT_TRANSACTION_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM tozon_import.batches WHERE id=NEW.source_import_batch_id AND source_ref='yeslzrrcwgcqfxhgbrqk') THEN RAISE EXCEPTION 'SOURCE_BATCH_REQUIRED';END IF;
  IF NEW.contract_number IS NULL OR btrim(NEW.contract_number)='' THEN RAISE EXCEPTION 'SOURCE_CONTRACT_NUMBER_REQUIRED';END IF;
  IF NEW.company_project_id IS NOT NULL OR NEW.company_director_snapshot IS NOT NULL OR NEW.company_closure_snapshot IS NOT NULL THEN
   RAISE EXCEPTION 'LEGACY_SCOPE_SNAPSHOT_MUST_NOT_BE_INVENTED';
  END IF;
 END IF;
 RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION tozon_internal.guard_imported_deal_identity() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER aa_imported_deal_source_guard BEFORE INSERT OR UPDATE ON public.deals FOR EACH ROW EXECUTE FUNCTION tozon_internal.guard_imported_deal_identity();
CREATE OR REPLACE FUNCTION tozon_internal.assign_document_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'tozon_internal', 'pg_temp'
AS $function$
DECLARE v_data jsonb; v_pattern text; v_kind text; v_number text; v_project text := ''; v_unit text := ''; v_building text := '';
BEGIN
 IF TG_TABLE_NAME='deals' AND to_jsonb(NEW)->>'source_import_batch_id' IS NOT NULL THEN
  IF current_user<>'postgres' OR current_setting('tozon.import_batch',true) IS DISTINCT FROM to_jsonb(NEW)->>'source_import_batch_id' THEN RAISE EXCEPTION 'OWNER_IMPORT_TRANSACTION_REQUIRED' USING ERRCODE='42501';END IF;
  RETURN NEW;
 END IF;
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
   IF EXISTS(SELECT 1 FROM public.deals WHERE contract_number=v_number AND source_import_batch_id IS NULL) THEN RAISE EXCEPTION 'NUMBER_ALREADY_EXISTS'; END IF;
   NEW.contract_number:=v_number;
 ELSE NEW.document_number:=v_number;
 END IF;
 RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION tozon_internal.queue_deal_sms()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'tozon_internal', 'pg_temp'
AS $function$
DECLARE typ text;
BEGIN
 -- INSERT has already passed the owner-only import guard.
 IF TG_OP='INSERT' AND NEW.source_import_batch_id IS NOT NULL THEN RETURN NEW;END IF;
 IF TG_OP='INSERT' THEN
  typ:=CASE NEW.status WHEN 'RESERVED' THEN 'RESERVATION_CREATED' WHEN 'SIGNED' THEN 'CONTRACT_CREATED' END;
 ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
  typ:=CASE WHEN NEW.status='SIGNED' THEN 'CONTRACT_CREATED' WHEN NEW.status='CANCELLED' AND OLD.status='RESERVED' THEN 'RESERVATION_CANCELLED' WHEN NEW.status='CANCELLED' THEN 'CONTRACT_TERMINATED' END;
 ELSIF NEW.status='SIGNED' AND (NEW.final_price_minor IS DISTINCT FROM OLD.final_price_minor OR NEW.unit_id IS DISTINCT FROM OLD.unit_id) THEN
  typ:='CONTRACT_CHANGED';
 END IF;
 IF typ IS NOT NULL THEN
  PERFORM tozon_internal.queue_configured_sms(typ,typ||':'||NEW.id||':'||CASE WHEN typ='CONTRACT_CHANGED' THEN txid_current()::text ELSE 'created' END,NEW.lead_id,NEW.id);
 END IF;
 RETURN NEW;
END $function$
;
REVOKE ALL ON FUNCTION tozon_internal.assign_document_number() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION tozon_internal.queue_deal_sms() FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.deals ADD CONSTRAINT deals_marketing_partner_id_fkey FOREIGN KEY(marketing_partner_id) REFERENCES public.marketing_partners(id) ON DELETE SET NULL;
ALTER TABLE public.deals ADD CONSTRAINT deals_source_confirmed_by_fkey FOREIGN KEY(source_confirmed_by) REFERENCES public.users(id) ON DELETE SET NULL;
COMMIT;
