-- No existing payments are updated. Counter allocation is transactional.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.payments IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE customer_pko_cutover_guard ON COMMIT DROP AS
 SELECT md5(coalesce(jsonb_agg(to_jsonb(p) ORDER BY id)::text,'[]')) AS hash FROM public.payments p;

CREATE SCHEMA IF NOT EXISTS tozon_internal;
ALTER TABLE public.payments ADD COLUMN customer_pko_number bigint;
CREATE UNIQUE INDEX payments_customer_pko_number_key ON public.payments(customer_pko_number)
 WHERE customer_pko_number IS NOT NULL;

CREATE FUNCTION tozon_internal.is_customer_pko(p jsonb) RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
 SELECT p->>'deal_id' IS NOT NULL
   AND coalesce(p->>'operation_type','STANDARD')='STANDARD'
   AND coalesce(p->>'settlement_method','CASH')='CASH'
   AND p->>'transfer_id' IS NULL AND p->>'conversion_id' IS NULL
$$;
REVOKE ALL ON FUNCTION tozon_internal.is_customer_pko(jsonb) FROM PUBLIC,anon,authenticated;

CREATE TABLE tozon_internal.customer_pko_counter (
 id smallint PRIMARY KEY CHECK(id=1), last_number bigint NOT NULL CHECK(last_number>=94)
);
ALTER TABLE tozon_internal.customer_pko_counter ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tozon_internal.customer_pko_counter FROM PUBLIC,anon,authenticated,service_role;
-- Continue the most recently issued numeric customer receipt. Historical
-- numbers in another range (e.g. 9503) do not reset the current series.
INSERT INTO tozon_internal.customer_pko_counter(id,last_number)
 SELECT 1,greatest(94,coalesce((
   SELECT regexp_replace(upper(trim(coalesce(nullif(p.document_number,''),p.reference))), '^ПКО[- ]*','')::bigint
   FROM public.payments p
   WHERE tozon_internal.is_customer_pko(to_jsonb(p))
     AND regexp_replace(upper(trim(coalesce(nullif(p.document_number,''),p.reference))), '^ПКО[- ]*','') ~ '^[0-9]{1,12}$'
   ORDER BY p.id DESC LIMIT 1
 ),94));

CREATE FUNCTION tozon_internal.assign_customer_pko_number() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n bigint;
BEGIN
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
END $$;
REVOKE ALL ON FUNCTION tozon_internal.assign_customer_pko_number() FROM PUBLIC,anon,authenticated,service_role;
-- PostgreSQL executes same-event triggers alphabetically: apply the buyer
-- series after the generic crm_payment_number template, leaving other types alone.
CREATE TRIGGER zz_customer_pko_number BEFORE INSERT OR UPDATE OR DELETE ON public.payments
 FOR EACH ROW EXECUTE FUNCTION tozon_internal.assign_customer_pko_number();

DO $$ BEGIN
 IF (SELECT hash FROM customer_pko_cutover_guard) IS DISTINCT FROM
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(p)-'customer_pko_number' ORDER BY id)::text,'[]')) FROM public.payments p) THEN
   RAISE EXCEPTION 'CUSTOMER_PKO_EXISTING_PAYMENTS_CHANGED';
 END IF;
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;
