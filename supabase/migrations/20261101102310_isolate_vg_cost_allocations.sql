BEGIN;
CREATE OR REPLACE FUNCTION public.guard_vg_cost_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE source_desk uuid; target_project integer; target_id integer;
 vg uuid := '9dc0e06d-5e0b-4bad-8bb7-83161d7a70a2';
BEGIN
 SELECT cash_desk_id INTO source_desk FROM public.expenses WHERE id=NEW.expense_id FOR SHARE;
 IF TG_TABLE_NAME='cost_expense_allocations' THEN
   IF NEW.mode NOT IN ('DIRECT','SHARED') THEN RETURN NEW; END IF;
   FOR target_id IN SELECT (s->>'building_id')::integer FROM jsonb_array_elements(NEW.shares) s LOOP
     SELECT project_id INTO target_project FROM public.buildings WHERE id=target_id;
     IF target_project IS NULL OR ((target_project=4) <> (source_desk IS NOT DISTINCT FROM vg)) THEN
       RAISE EXCEPTION 'Расходы А/Б и В/Г распределяются только внутри своего объекта и своей кассы' USING ERRCODE='23514';
     END IF;
   END LOOP;
 ELSE
   SELECT b.project_id INTO target_project FROM public.cost_material_usages u JOIN public.buildings b ON b.id=u.building_id WHERE u.id=NEW.usage_id;
   IF target_project IS NULL OR ((target_project=4) <> (source_desk IS NOT DISTINCT FROM vg)) THEN
     RAISE EXCEPTION 'Оплату материалов А/Б и В/Г нельзя связывать с другим объектом' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_vg_cost_assignment() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_vg_cost_assignment ON public.cost_expense_allocations;
CREATE TRIGGER guard_vg_cost_assignment BEFORE INSERT OR UPDATE OF expense_id,mode,shares ON public.cost_expense_allocations FOR EACH ROW EXECUTE FUNCTION public.guard_vg_cost_assignment();
DROP TRIGGER IF EXISTS guard_vg_material_payment ON public.cost_material_payment_links;
CREATE TRIGGER guard_vg_material_payment BEFORE INSERT OR UPDATE OF expense_id,usage_id ON public.cost_material_payment_links FOR EACH ROW EXECUTE FUNCTION public.guard_vg_cost_assignment();

CREATE OR REPLACE FUNCTION public.guard_vg_material_usage() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE target_project integer; stock_project integer;
 vg uuid := '9dc0e06d-5e0b-4bad-8bb7-83161d7a70a2';
BEGIN
 SELECT project_id INTO target_project FROM public.buildings WHERE id=NEW.building_id;
 IF NEW.stock_entry_id IS NOT NULL THEN
   SELECT d.project_id INTO stock_project FROM public.construction_stock_entries s JOIN public.construction_documents d ON d.id=s.document_id WHERE s.id=NEW.stock_entry_id;
   IF (target_project IS NOT DISTINCT FROM 4) <> (stock_project IS NOT DISTINCT FROM 4) THEN
     RAISE EXCEPTION 'Материалы А/Б и В/Г учитываются отдельно по объектам' USING ERRCODE='23514';
   END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM public.cost_material_payment_links p JOIN public.expenses e ON e.id=p.expense_id
   WHERE p.usage_id=NEW.id AND p.status='ACTIVE' AND ((target_project IS NOT DISTINCT FROM 4) <> (e.cash_desk_id IS NOT DISTINCT FROM vg))) THEN
   RAISE EXCEPTION 'Нельзя перенести материалы с оплатами между блоками А/Б и В/Г' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_vg_material_usage() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_vg_material_usage ON public.cost_material_usages;
CREATE TRIGGER guard_vg_material_usage BEFORE INSERT OR UPDATE OF building_id,stock_entry_id ON public.cost_material_usages FOR EACH ROW EXECUTE FUNCTION public.guard_vg_material_usage();
COMMIT;
