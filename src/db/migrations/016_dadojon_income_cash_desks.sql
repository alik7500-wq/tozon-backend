-- Migration: 016_dadojon_income_cash_desks.sql
-- Description: Расширение прав Дадочона на прием платежей (ПКО) в кассы Акмалхона и Илхомчона
--              с сохранением строгой изоляции остатков и расходов (can_view=false, can_create_expense=false)

BEGIN;

DO $$
DECLARE
  v_user_id INT;
  v_dado_desk_id UUID;
  v_akmal_desk_id UUID;
  v_ilhom_desk_id UUID;
  v_admin_id INT;
BEGIN
  -- 1. Поиск пользователя Дадочона (id=3)
  SELECT id INTO v_user_id
  FROM public.users
  WHERE id = 3 AND email = 'manager1@tozon.tj' AND role = 'SALES_MANAGER';

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: Пользователь id=3 (manager1@tozon.tj) не найден';
  END IF;

  -- 2. Поиск ID касс
  SELECT id INTO v_dado_desk_id FROM public.dictionaries WHERE code = 'SALES_MANAGER_Dadojon' AND type = 'CASH_DESK';
  SELECT id INTO v_akmal_desk_id FROM public.dictionaries WHERE code = 'SALES_MANAGER' AND type = 'CASH_DESK';
  SELECT id INTO v_ilhom_desk_id FROM public.dictionaries WHERE code = 'MAIN_CASHIER' AND type = 'CASH_DESK';

  IF v_dado_desk_id IS NULL OR v_akmal_desk_id IS NULL OR v_ilhom_desk_id IS NULL THEN
    RAISE EXCEPTION 'CASH_DESK_NOT_FOUND: Одна из необходимых касс не найдена в dictionaries';
  END IF;

  -- Поиск активного администратора
  SELECT MAX(id) INTO v_admin_id FROM public.users WHERE role = 'ADMIN' AND is_active = 1;

  -- 3. Касса Дадочона: полный доступ к своей кассе (просмотр, приход, расход в пределах остатка)
  INSERT INTO public.user_cash_desk_access (
    user_id, cash_desk_id, can_view, can_create_income, can_create_expense, can_edit, can_void, can_delete, created_by
  ) VALUES (
    v_user_id, v_dado_desk_id, true, true, true, false, false, false, v_admin_id
  ) ON CONFLICT (user_id, cash_desk_id) DO UPDATE
  SET can_view = true, can_create_income = true, can_create_expense = true, can_edit = false, can_void = false, can_delete = false;

  -- 4. Касса Акмалхона: ТОЛЬКО прием платежей (can_create_income=true), просмотр и расходы ЗАПРЕЩЕНЫ
  INSERT INTO public.user_cash_desk_access (
    user_id, cash_desk_id, can_view, can_create_income, can_create_expense, can_edit, can_void, can_delete, created_by
  ) VALUES (
    v_user_id, v_akmal_desk_id, false, true, false, false, false, false, v_admin_id
  ) ON CONFLICT (user_id, cash_desk_id) DO UPDATE
  SET can_view = false, can_create_income = true, can_create_expense = false, can_edit = false, can_void = false, can_delete = false;

  -- 5. Касса Илхомчона: ТОЛЬКО прием платежей (can_create_income=true), просмотр и расходы ЗАПРЕЩЕНЫ
  INSERT INTO public.user_cash_desk_access (
    user_id, cash_desk_id, can_view, can_create_income, can_create_expense, can_edit, can_void, can_delete, created_by
  ) VALUES (
    v_user_id, v_ilhom_desk_id, false, true, false, false, false, false, v_admin_id
  ) ON CONFLICT (user_id, cash_desk_id) DO UPDATE
  SET can_view = false, can_create_income = true, can_create_expense = false, can_edit = false, can_void = false, can_delete = false;

END $$;

COMMIT;
