BEGIN;
-- Historical cash is immutable and enters only through an owner import transaction.
CREATE FUNCTION tozon_internal.is_verified_cash_import(p jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $guard$
DECLARE b uuid;
BEGIN
 IF p->>'source_import_batch_id' IS NULL THEN RETURN false;END IF;
 IF current_user<>'postgres' OR current_setting('tozon.import_batch',true) IS DISTINCT FROM p->>'source_import_batch_id' THEN
  RAISE EXCEPTION 'OWNER_IMPORT_TRANSACTION_REQUIRED' USING ERRCODE='42501';
 END IF;
 b:=(p->>'source_import_batch_id')::uuid;
 IF NOT EXISTS(SELECT 1 FROM tozon_import.batches WHERE id=b AND source_ref='yeslzrrcwgcqfxhgbrqk') THEN RAISE EXCEPTION 'SOURCE_BATCH_REQUIRED';END IF;
 RETURN true;
END $guard$;
CREATE FUNCTION tozon_internal.guard_imported_cash_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $guard$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.source_import_batch_id IS NOT NULL THEN RAISE EXCEPTION 'IMPORTED_CASH_HISTORY_READ_ONLY';END IF;
  RETURN OLD;
 ELSIF TG_OP='UPDATE' THEN
  IF NEW.source_import_batch_id IS DISTINCT FROM OLD.source_import_batch_id THEN RAISE EXCEPTION 'IMPORT_SOURCE_IMMUTABLE';END IF;
  IF OLD.source_import_batch_id IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'IMPORTED_CASH_HISTORY_READ_ONLY';END IF;
 ELSE
  PERFORM tozon_internal.is_verified_cash_import(to_jsonb(NEW));
 END IF;
 RETURN NEW;
END $guard$;
ALTER TABLE public.payments ADD COLUMN source_import_batch_id uuid REFERENCES tozon_import.batches(id) ON DELETE RESTRICT;
CREATE TRIGGER aa_imported_cash_source_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payments FOR EACH ROW EXECUTE FUNCTION tozon_internal.guard_imported_cash_identity();
ALTER TABLE public.expenses ADD COLUMN source_import_batch_id uuid REFERENCES tozon_import.batches(id) ON DELETE RESTRICT;
CREATE TRIGGER aa_imported_cash_source_guard BEFORE INSERT OR UPDATE OR DELETE ON public.expenses FOR EACH ROW EXECUTE FUNCTION tozon_internal.guard_imported_cash_identity();
ALTER TABLE public.cash_transfers ADD COLUMN source_import_batch_id uuid REFERENCES tozon_import.batches(id) ON DELETE RESTRICT;
CREATE TRIGGER aa_imported_cash_source_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cash_transfers FOR EACH ROW EXECUTE FUNCTION tozon_internal.guard_imported_cash_identity();
ALTER TABLE public.barter_realization_results ADD COLUMN source_import_batch_id uuid REFERENCES tozon_import.batches(id) ON DELETE RESTRICT;
CREATE TRIGGER aa_imported_cash_source_guard BEFORE INSERT OR UPDATE OR DELETE ON public.barter_realization_results FOR EACH ROW EXECUTE FUNCTION tozon_internal.guard_imported_cash_identity();
DROP INDEX public.crm_payment_document_number;
CREATE UNIQUE INDEX crm_payment_document_number ON public.payments(document_number) WHERE document_number IS NOT NULL AND source_import_batch_id IS NULL;
CREATE UNIQUE INDEX payments_import_document_number ON public.payments(source_import_batch_id,document_number) WHERE document_number IS NOT NULL AND source_import_batch_id IS NOT NULL;
DROP INDEX public.crm_expense_document_number;
CREATE UNIQUE INDEX crm_expense_document_number ON public.expenses(document_number) WHERE document_number IS NOT NULL AND source_import_batch_id IS NULL;
CREATE UNIQUE INDEX expenses_import_document_number ON public.expenses(source_import_batch_id,document_number) WHERE document_number IS NOT NULL AND source_import_batch_id IS NOT NULL;
DROP INDEX public.payments_customer_pko_number_key;
CREATE UNIQUE INDEX payments_customer_pko_number_key ON public.payments(customer_pko_number) WHERE customer_pko_number IS NOT NULL AND source_import_batch_id IS NULL;
CREATE UNIQUE INDEX payments_import_customer_pko_number ON public.payments(source_import_batch_id,customer_pko_number) WHERE customer_pko_number IS NOT NULL AND source_import_batch_id IS NOT NULL;
-- Source-only EMPLOYEE settlement is retained; native allowed values stay unchanged.
ALTER TABLE public.expenses DROP CONSTRAINT expenses_settlement_account_check;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_settlement_account_check CHECK(settlement_account IN ('PAYABLE','ADVANCE_GIVEN','RECEIVABLE','ADVANCE_RECEIVED') OR (source_import_batch_id IS NOT NULL AND settlement_account='EMPLOYEE'));
CREATE OR REPLACE FUNCTION tozon_internal.assign_customer_pko_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'tozon_internal', 'pg_temp'
AS $function$
DECLARE n bigint;
BEGIN
 IF TG_OP='INSERT' AND tozon_internal.is_verified_cash_import(to_jsonb(NEW)) THEN RETURN NEW;END IF;

 IF TG_OP='DELETE' THEN
   IF OLD.customer_pko_number IS NOT NULL OR tozon_internal.is_customer_pko(to_jsonb(OLD)) THEN
     RAISE EXCEPTION 'CUSTOMER_PKO_MUST_BE_VOIDED: Аннулируйте ПКО вместо удаления';
   END IF;
   RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
   IF OLD.customer_pko_number IS NOT NULL OR tozon_internal.is_customer_pko(to_jsonb(OLD)) THEN
     IF NEW.reference IS DISTINCT FROM OLD.reference
        OR NEW.document_number IS DISTINCT FROM OLD.document_number
        OR NEW.customer_pko_number IS DISTINCT FROM OLD.customer_pko_number
        OR NEW.deal_id IS DISTINCT FROM OLD.deal_id
        OR NEW.operation_type IS DISTINCT FROM OLD.operation_type
        OR NEW.settlement_method IS DISTINCT FROM OLD.settlement_method
        OR NEW.transfer_id IS DISTINCT FROM OLD.transfer_id
        OR NEW.conversion_id IS DISTINCT FROM OLD.conversion_id THEN
       RAISE EXCEPTION 'CUSTOMER_PKO_NUMBER_IMMUTABLE: Номер и принадлежность ПКО покупателя сохраняются';
     END IF;
   ELSIF NEW.customer_pko_number IS NOT NULL OR tozon_internal.is_customer_pko(to_jsonb(NEW)) THEN
     RAISE EXCEPTION 'CUSTOMER_PKO_REQUIRES_NEW_DOCUMENT: Оформите отдельный ПКО покупателя';
   END IF;
   RETURN NEW;
 END IF;
 IF NOT tozon_internal.is_customer_pko(to_jsonb(NEW)) THEN
   NEW.customer_pko_number:=NULL;
   RETURN NEW;
 END IF;
 -- The single row lock serializes all currencies, cash desks and app instances.
 LOOP
   UPDATE tozon_internal.customer_pko_counter SET last_number=last_number+1
   WHERE id=1 RETURNING last_number INTO n;
   IF n IS NULL THEN RAISE EXCEPTION 'CUSTOMER_PKO_COUNTER_MISSING'; END IF;
   EXIT WHEN NOT EXISTS (
     SELECT 1 FROM public.payments p WHERE
       p.customer_pko_number=n OR
       ltrim(regexp_replace(upper(trim(p.reference)), '^ПКО[- ]*',''),'0')=n::text OR
       ltrim(regexp_replace(upper(trim(p.document_number)), '^ПКО[- ]*',''),'0')=n::text
   );
 END LOOP;
 NEW.customer_pko_number:=n;
 NEW.reference:='ПКО-'||n::text;
 NEW.document_number:=NEW.reference;
 RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION tozon_internal.assign_document_number()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'tozon_internal', 'pg_temp'
AS $function$
DECLARE v_data jsonb; v_pattern text; v_kind text; v_number text; v_project text := ''; v_unit text := ''; v_building text := '';
BEGIN
 IF TG_TABLE_NAME IN ('payments','expenses') AND tozon_internal.is_verified_cash_import(to_jsonb(NEW)) THEN RETURN NEW;END IF;

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
CREATE OR REPLACE FUNCTION public.construction_audit_expense_settlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'tozon_internal', 'pg_temp'
AS $function$
declare before_row jsonb; after_row jsonb;
begin
 IF TG_OP='INSERT' AND tozon_internal.is_verified_cash_import(to_jsonb(NEW)) THEN RETURN NEW;END IF;

 if tg_op<>'INSERT' then before_row=to_jsonb(old); end if;
 if tg_op<>'DELETE' then after_row=to_jsonb(new); end if;
 if coalesce(before_row->>'settlement_party_id',after_row->>'settlement_party_id') is not null
 and (tg_op<>'UPDATE' or (before_row-array['reference','updated_at','settlement_updated_by']) is distinct from (after_row-array['reference','updated_at','settlement_updated_by'])) then
  insert into public.construction_expense_settlement_audit(expense_id,actor_id,operation,before_data,after_data)
  values(coalesce((after_row->>'id')::integer,(before_row->>'id')::integer),case when tg_op='DELETE' then null else (after_row->>'settlement_updated_by')::integer end,tg_op,before_row,after_row);
 end if;
 return coalesce(new,old);
end $function$
;
CREATE OR REPLACE FUNCTION public.construction_validate_expense_settlement()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'tozon_internal', 'pg_temp'
AS $function$
begin
 IF TG_OP='INSERT' AND tozon_internal.is_verified_cash_import(to_jsonb(NEW)) THEN RETURN NEW;END IF;

 if new.settlement_party_id is not null then
  if not exists(select 1 from public.construction_parties where id=new.settlement_party_id and kind<>'EMPLOYEE' and active) then
   -- Archiving a party must not prevent voiding an existing cash document.
   if tg_op='INSERT' or new.settlement_party_id is distinct from old.settlement_party_id or coalesce(new.status,'ACTIVE')='ACTIVE' and new.voided_at is null then
    raise exception 'Выберите активного поставщика, подрядчика или дебитора';
   end if;
  end if;
  if new.currency not in ('TJS','USD') or new.amount_minor<=0 or new.expense_date<(select start_date from public.construction_settings where id=1)
   or new.transfer_id is not null or coalesce(new.operation_type,'STANDARD') not in ('STANDARD','EXPENSE')
   or new.category in ('Конвертация валюты','Внутренние перемещения между кассами','CURRENCY_CONVERSION','INTERNAL_TRANSFER')
   or (new.conversion_id is not null and new.conversion_expense_id is null) then
   raise exception 'Связать с расчётами можно только расходный РКО с даты начала учёта';
  end if;
  if exists(select 1 from public.construction_documents where expense_id=new.id and status<>'CANCELLED') then
   raise exception 'РКО уже связан с документом строительного учёта. Повторная оплата запрещена';
  end if;
 end if;
 return new;
end $function$
;
CREATE OR REPLACE FUNCTION tozon_internal.queue_payment_sms()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'tozon_internal', 'pg_temp'
AS $function$
DECLARE d public.deals%ROWTYPE; typ text;
BEGIN
 IF TG_OP='INSERT' AND tozon_internal.is_verified_cash_import(to_jsonb(NEW)) THEN RETURN NEW;END IF;

 IF NEW.deal_id IS NULL OR COALESCE(NEW.operation_type,'STANDARD') NOT IN ('STANDARD','INCOME','DEAL_PAYMENT') THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' AND NEW.status IS DISTINCT FROM 'VOIDED' THEN typ:='PAYMENT_RECEIVED';
 ELSIF TG_OP='UPDATE' AND OLD.status IS DISTINCT FROM 'VOIDED' AND NEW.status='VOIDED' THEN typ:='PAYMENT_CANCELLED'; END IF;
 SELECT * INTO d FROM public.deals WHERE id=NEW.deal_id;
 IF typ IS NOT NULL THEN PERFORM tozon_internal.queue_configured_sms(typ,typ||':'||NEW.id,d.lead_id,d.id,NEW.id); END IF;
 IF typ='PAYMENT_RECEIVED' AND d.status='SIGNED' AND d.final_price_minor>0 AND (SELECT COALESCE(sum(amount_minor),0) FROM public.payments WHERE deal_id=d.id AND status IS DISTINCT FROM 'VOIDED')>=d.final_price_minor THEN
  PERFORM tozon_internal.queue_configured_sms('CONTRACT_PAID','CONTRACT_PAID:'||d.id,d.lead_id,d.id);
 END IF;
 RETURN NEW;
END $function$
;
REVOKE ALL ON FUNCTION tozon_internal.is_verified_cash_import(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION tozon_internal.guard_imported_cash_identity() FROM PUBLIC,anon,authenticated,service_role;
-- Trigger callers need this invoker verifier. It returns false for native rows and
-- always rejects service-role attempts to supply an import marker.
GRANT EXECUTE ON FUNCTION tozon_internal.is_verified_cash_import(jsonb) TO service_role;
REVOKE ALL ON FUNCTION tozon_internal.assign_customer_pko_number() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION tozon_internal.assign_document_number() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.construction_audit_expense_settlement() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.construction_validate_expense_settlement() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION tozon_internal.queue_payment_sms() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
