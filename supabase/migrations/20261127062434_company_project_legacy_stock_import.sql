BEGIN;
-- Configuration is archived as source evidence, never applied to global pilot settings.
CREATE TABLE tozon_import.contexts(
 batch_id uuid NOT NULL REFERENCES tozon_import.batches(id) ON DELETE RESTRICT,
 kind text NOT NULL,
 payload jsonb NOT NULL,
 PRIMARY KEY(batch_id,kind)
);
ALTER TABLE tozon_import.contexts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE tozon_import.contexts FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION tozon_internal.guard_imported_stock_history() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $guard$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.source_import_batch_id IS NOT NULL THEN RAISE EXCEPTION 'IMPORTED_STOCK_HISTORY_READ_ONLY';END IF;
  RETURN OLD;
 ELSIF TG_OP='UPDATE' THEN
  IF NEW.source_import_batch_id IS DISTINCT FROM OLD.source_import_batch_id THEN RAISE EXCEPTION 'IMPORT_SOURCE_IMMUTABLE';END IF;
  IF OLD.source_import_batch_id IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'IMPORTED_STOCK_HISTORY_READ_ONLY';END IF;
 ELSE
  -- Invoker verifier rejects service-role imports even with a forged session setting.
  PERFORM tozon_internal.is_verified_cash_import(to_jsonb(NEW));
 END IF;
 RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION tozon_internal.guard_imported_stock_history() FROM PUBLIC,anon,authenticated,service_role;

DO $tables$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['construction_warehouses','construction_materials','construction_documents','construction_stock_entries','construction_settlement_entries','construction_price_corrections','construction_expense_settlement_audit','construction_report_receipts'] LOOP
  EXECUTE format('ALTER TABLE public.%I ADD COLUMN source_import_batch_id uuid REFERENCES tozon_import.batches(id) ON DELETE RESTRICT',t);
  EXECUTE format('CREATE TRIGGER aa_imported_stock_source_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION tozon_internal.guard_imported_stock_history()',t);
 END LOOP;
END $tables$;
-- A deleted source expense remains audit evidence, not a recreated live RKO.
ALTER TABLE public.construction_expense_settlement_audit ADD COLUMN source_expense_id integer;
ALTER TABLE public.construction_expense_settlement_audit ALTER COLUMN expense_id DROP NOT NULL;
ALTER TABLE public.construction_expense_settlement_audit ADD CONSTRAINT audit_live_or_deleted_source_expense CHECK(
 expense_id IS NOT NULL OR (source_import_batch_id IS NOT NULL AND source_expense_id IS NOT NULL)
);
ALTER TABLE public.construction_expense_settlement_audit ADD CONSTRAINT audit_source_expense_requires_import CHECK(
 source_expense_id IS NULL OR source_import_batch_id IS NOT NULL
);
COMMIT;
