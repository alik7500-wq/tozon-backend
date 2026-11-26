BEGIN;

CREATE FUNCTION public.void_cash_expense_autoconversion(p_expense_id integer, p_actor integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  main public.expenses%ROWTYPE;
  fx_out public.expenses%ROWTYPE;
  fx_in public.payments%ROWTYPE;
  fx uuid;
  expense_count integer;
  payment_count integer;
  void_time timestamptz := statement_timestamp();
  reason text := 'Аннулирован основной РКО и его автоконвертация';
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = p_actor AND u.role::text = 'ADMIN'
      AND u.is_active = 1
  ) THEN
    RAISE EXCEPTION 'Аннулирование автоконвертации доступно только администратору' USING ERRCODE = '42501';
  END IF;

  SELECT conversion_id INTO fx FROM public.expenses WHERE id = p_expense_id;
  IF fx IS NULL THEN
    RAISE EXCEPTION 'У расходного РКО нет полной связи с автоконвертацией';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('void-autoconversion:' || fx::text, 0));
  PERFORM 1 FROM public.expenses WHERE conversion_id = fx ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.payments WHERE conversion_id = fx ORDER BY id FOR UPDATE;

  SELECT * INTO main FROM public.expenses WHERE id = p_expense_id AND conversion_id = fx;
  SELECT * INTO fx_out FROM public.expenses WHERE id = main.conversion_expense_id AND conversion_id = fx;
  SELECT count(*) INTO expense_count FROM public.expenses WHERE conversion_id = fx;
  SELECT count(*) INTO payment_count FROM public.payments WHERE conversion_id = fx;
  SELECT * INTO fx_in FROM public.payments WHERE conversion_id = fx;

  IF expense_count <> 2 OR payment_count <> 1
    OR main.id IS NULL OR fx_out.id IS NULL OR main.id = fx_out.id
    OR main.transfer_id IS NOT NULL OR fx_out.transfer_id IS NOT NULL OR fx_in.transfer_id IS NOT NULL
    OR fx_out.conversion_expense_id IS NOT NULL OR fx_in.deal_id IS NOT NULL
    OR coalesce(main.operation_type, 'STANDARD') NOT IN ('STANDARD', 'EXPENSE')
    OR coalesce(fx_out.operation_type, 'STANDARD') NOT IN ('STANDARD', 'CONVERSION')
    OR coalesce(fx_in.operation_type, 'STANDARD') NOT IN ('STANDARD', 'CONVERSION')
    OR fx_out.category IS DISTINCT FROM 'Конвертация валюты'
    OR main.category = 'Конвертация валюты'
    OR main.currency IS DISTINCT FROM 'TJS' OR fx_in.currency IS DISTINCT FROM 'TJS'
    OR fx_out.currency IS DISTINCT FROM 'USD'
    OR fx_in.amount_minor IS DISTINCT FROM main.amount_minor
    OR main.amount_minor IS NULL OR main.amount_minor <= 0
    OR fx_out.amount_minor IS NULL OR fx_out.amount_minor <= 0
    OR main.cash_desk_id IS NULL
    OR fx_out.cash_desk_id IS DISTINCT FROM main.cash_desk_id
    OR fx_in.cash_desk_id IS DISTINCT FROM main.cash_desk_id
    OR EXISTS (SELECT 1 FROM public.expenses WHERE conversion_expense_id = fx_out.id AND id <> main.id)
  THEN
    RAISE EXCEPTION 'Не удалось однозначно определить все три ордера автоконвертации. Требуется сверка';
  END IF;

  IF main.status = 'VOIDED' AND fx_out.status = 'VOIDED' AND fx_in.status = 'VOIDED' THEN
    RETURN jsonb_build_object('success', true, 'idempotent', true);
  END IF;
  IF coalesce(main.status, 'ACTIVE') <> 'ACTIVE'
    OR coalesce(fx_out.status, 'ACTIVE') <> 'ACTIVE'
    OR coalesce(fx_in.status, 'ACTIVE') <> 'ACTIVE'
    OR main.voided_at IS NOT NULL OR fx_out.voided_at IS NOT NULL OR fx_in.voided_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'Один из связанных ордеров уже отменён. Требуется сверка';
  END IF;

  UPDATE public.expenses SET status = 'VOIDED', voided_at = void_time,
    voided_by = p_actor, void_reason = reason,
    settlement_updated_by = CASE WHEN settlement_party_id IS NOT NULL THEN p_actor ELSE settlement_updated_by END
  WHERE id IN (main.id, fx_out.id);
  UPDATE public.payments SET status = 'VOIDED', voided_at = void_time,
    voided_by = p_actor, void_reason = reason WHERE id = fx_in.id;

  RETURN jsonb_build_object('success', true, 'expense_id', main.id,
    'conversion_expense_id', fx_out.id, 'conversion_payment_id', fx_in.id);
END;
$$;

REVOKE ALL ON FUNCTION public.void_cash_expense_autoconversion(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.void_cash_expense_autoconversion(integer, integer) TO service_role;
NOTIFY pgrst, 'reload schema';

COMMIT;
