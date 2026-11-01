BEGIN;
INSERT INTO public.dictionaries (id,type,name,code,color,icon,sort_order,is_active,is_system)
VALUES ('9dc0e06d-5e0b-4bad-8bb7-83161d7a70a2','CASH_DESK','Касса ЖК ТОЗОН ПЛАЗА — 2 (блоки В и Г)','TOZON_PLAZA_2_CASH','#2563eb','🏗️',12,true,true)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.guard_vg_cash_document() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE project_number integer; vg uuid := '9dc0e06d-5e0b-4bad-8bb7-83161d7a70a2';
BEGIN
  IF TG_OP='UPDATE' AND (OLD.cash_desk_id IS NOT DISTINCT FROM vg) <> (NEW.cash_desk_id IS NOT DISTINCT FROM vg) THEN
    RAISE EXCEPTION 'Операции А/Б и В/Г нельзя переносить между кассами разных объектов' USING ERRCODE='23514';
  END IF;
  IF NEW.deal_id IS NOT NULL THEN
    SELECT b.project_id INTO project_number FROM public.deals d JOIN public.units u ON u.id=d.unit_id
    JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id
    JOIN public.buildings b ON b.id=s.building_id WHERE d.id=NEW.deal_id;
    IF project_number=4 AND NEW.cash_desk_id IS DISTINCT FROM vg THEN
      RAISE EXCEPTION 'Для блоков В и Г выберите кассу ЖК ТОЗОН ПЛАЗА — 2' USING ERRCODE='23514';
    ELSIF project_number IS NOT NULL AND project_number<>4 AND NEW.cash_desk_id=vg THEN
      RAISE EXCEPTION 'Касса В/Г не принимает операции других объектов' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_vg_cash_document() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_vg_cash_document ON public.payments;
CREATE TRIGGER guard_vg_cash_document BEFORE INSERT OR UPDATE OF cash_desk_id,deal_id ON public.payments FOR EACH ROW EXECUTE FUNCTION public.guard_vg_cash_document();
DROP TRIGGER IF EXISTS guard_vg_cash_document ON public.expenses;
CREATE TRIGGER guard_vg_cash_document BEFORE INSERT OR UPDATE OF cash_desk_id,deal_id ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.guard_vg_cash_document();

CREATE OR REPLACE FUNCTION public.guard_vg_cash_transfer() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE vg uuid := '9dc0e06d-5e0b-4bad-8bb7-83161d7a70a2';
BEGIN
  IF (NEW.source_cash_desk_id IS NOT DISTINCT FROM vg) <> (NEW.destination_cash_desk_id IS NOT DISTINCT FROM vg) THEN
    RAISE EXCEPTION 'Перемещения между кассами А/Б и В/Г запрещены: раздельный учёт' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_vg_cash_transfer() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_vg_cash_transfer ON public.cash_transfers;
CREATE TRIGGER guard_vg_cash_transfer BEFORE INSERT OR UPDATE OF source_cash_desk_id,destination_cash_desk_id ON public.cash_transfers FOR EACH ROW EXECUTE FUNCTION public.guard_vg_cash_transfer();
CREATE OR REPLACE FUNCTION public.guard_vg_deal_reassignment() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE old_project integer; new_project integer;
BEGIN
  IF NEW.unit_id IS NOT DISTINCT FROM OLD.unit_id THEN RETURN NEW; END IF;
  SELECT b.project_id INTO old_project FROM public.units u JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id WHERE u.id=OLD.unit_id;
  SELECT b.project_id INTO new_project FROM public.units u JOIN public.floors f ON f.id=u.floor_id JOIN public.sections s ON s.id=f.section_id JOIN public.buildings b ON b.id=s.building_id WHERE u.id=NEW.unit_id;
  IF (old_project IS NOT DISTINCT FROM 4) <> (new_project IS NOT DISTINCT FROM 4)
    AND (EXISTS(SELECT 1 FROM public.payments WHERE deal_id=OLD.id) OR EXISTS(SELECT 1 FROM public.expenses WHERE deal_id=OLD.id)) THEN
    RAISE EXCEPTION 'Договор с оплатами нельзя переносить между объектами А/Б и В/Г' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_vg_deal_reassignment() FROM PUBLIC;
DROP TRIGGER IF EXISTS guard_vg_deal_reassignment ON public.deals;
CREATE TRIGGER guard_vg_deal_reassignment BEFORE UPDATE OF unit_id ON public.deals FOR EACH ROW EXECUTE FUNCTION public.guard_vg_deal_reassignment();
COMMIT;
