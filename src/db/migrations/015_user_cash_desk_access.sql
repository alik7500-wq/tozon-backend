-- Migration: 015_user_cash_desk_access.sql
-- Description: Изолированная касса менеджера Дадочона, модель доступа user_cash_desk_access,
--              реальная идемпотентность, безопасная нумерация (без MAX(id)+1), RLS и атомарный контроль
-- Safe DDL with validation checks, no hardcoded user IDs, fully qualified public.* names, safe search_path and tight permissions

BEGIN;

-- 1. Создание таблицы доступа пользователей к кассам
CREATE TABLE IF NOT EXISTS public.user_cash_desk_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL CONSTRAINT fk_user_cash_desk_user REFERENCES public.users(id) ON DELETE CASCADE,
  cash_desk_id UUID NOT NULL CONSTRAINT fk_user_cash_desk_dict REFERENCES public.dictionaries(id) ON DELETE CASCADE,
  can_view BOOLEAN NOT NULL DEFAULT true,
  can_create_income BOOLEAN NOT NULL DEFAULT false,
  can_create_expense BOOLEAN NOT NULL DEFAULT false,
  can_edit BOOLEAN NOT NULL DEFAULT false,
  can_void BOOLEAN NOT NULL DEFAULT false,
  can_delete BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INTEGER,
  CONSTRAINT uq_user_cash_desk UNIQUE (user_id, cash_desk_id)
);

CREATE INDEX IF NOT EXISTS idx_user_cash_desk_user_id ON public.user_cash_desk_access(user_id);
CREATE INDEX IF NOT EXISTS idx_user_cash_desk_desk_id ON public.user_cash_desk_access(cash_desk_id);

-- Включение Row Level Security и политика доступа только для service_role
ALTER TABLE public.user_cash_desk_access ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_user_cash_desk_access ON public.user_cash_desk_access;
CREATE POLICY service_role_all_user_cash_desk_access ON public.user_cash_desk_access
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 2. Добавление колонки идемпотентности в expenses
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128) UNIQUE;
CREATE INDEX IF NOT EXISTS idx_expenses_idempotency_key ON public.expenses(idempotency_key);

-- 3. Назначение прав для менеджера Дадочона с валидацией без хардкода
DO $$
DECLARE
  v_user_id INT;
  v_desk_id UUID;
  v_user_count INT;
  v_desk_count INT;
  v_admin_count INT;
  v_admin_id INT;
  v_created_by INT := NULL;
BEGIN
  -- Поиск пользователя id=3, manager1@tozon.tj, SALES_MANAGER
  SELECT COUNT(*), MAX(id) INTO v_user_count, v_user_id
  FROM public.users
  WHERE id = 3 AND email = 'manager1@tozon.tj' AND role = 'SALES_MANAGER';

  IF v_user_count <> 1 THEN
    RAISE EXCEPTION 'MIGRATION_ABORTED: Expected exactly 1 user with id=3, email=manager1@tozon.tj, role=SALES_MANAGER. Found: %', v_user_count;
  END IF;

  -- Поиск кассы по коду SALES_MANAGER_Dadojon
  SELECT COUNT(*), MAX(id::text)::uuid INTO v_desk_count, v_desk_id
  FROM public.dictionaries
  WHERE code = 'SALES_MANAGER_Dadojon' AND type = 'CASH_DESK';

  IF v_desk_count <> 1 THEN
    RAISE EXCEPTION 'MIGRATION_ABORTED: Expected exactly 1 cash desk with code=SALES_MANAGER_Dadojon. Found: %', v_desk_count;
  END IF;

  -- Поиск активного администратора для метки created_by
  SELECT COUNT(*), MAX(id) INTO v_admin_count, v_admin_id
  FROM public.users
  WHERE role = 'ADMIN' AND is_active = 1;

  IF v_admin_count = 1 THEN
    v_created_by := v_admin_id;
  END IF;

  -- Вставка или обновление записи доступа
  INSERT INTO public.user_cash_desk_access (
    user_id,
    cash_desk_id,
    can_view,
    can_create_income,
    can_create_expense,
    can_edit,
    can_void,
    can_delete,
    created_by
  ) VALUES (
    v_user_id,
    v_desk_id,
    true,   -- can_view (просмотр своей кассы и документов)
    true,   -- can_create_income (регистрация оплаты в свою кассу)
    true,   -- can_create_expense (оформление расхода в пределах остатка)
    false,  -- can_edit (запрещено)
    false,  -- can_void (запрещено)
    false,  -- can_delete (запрещено)
    v_created_by
  )
  ON CONFLICT (user_id, cash_desk_id) DO UPDATE
  SET 
    can_view = EXCLUDED.can_view,
    can_create_income = EXCLUDED.can_create_income,
    can_create_expense = EXCLUDED.can_create_expense,
    can_edit = EXCLUDED.can_edit,
    can_void = EXCLUDED.can_void,
    can_delete = EXCLUDED.can_delete;
END $$;

-- 4. Обновление функции create_atomic_cash_transfer: устранение MAX(id)+1, safe search_path, RLS/Grants
CREATE OR REPLACE FUNCTION public.create_atomic_cash_transfer(
  p_source_cash_desk_id UUID,
  p_destination_cash_desk_id UUID,
  p_operation_type VARCHAR,
  p_currency VARCHAR,
  p_amount_tjs NUMERIC,
  p_exchange_rate NUMERIC,
  p_amount_usd NUMERIC,
  p_transfer_date DATE,
  p_recipient VARCHAR,
  p_description TEXT,
  p_idempotency_key VARCHAR,
  p_user_id INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source_desk RECORD;
  v_dest_desk RECORD;
  v_final_amount_usd NUMERIC(14,2);
  v_final_amount_tjs NUMERIC(14,2);
  v_final_exchange_rate NUMERIC(12,6);
  v_amount_minor BIGINT;
  v_available_balance NUMERIC(14,2);
  v_source_income NUMERIC(14,2);
  v_source_expense NUMERIC(14,2);
  v_transfer_id UUID;
  v_expense_id INT;
  v_payment_id INT;
  v_rko_ref VARCHAR(64);
  v_pko_ref VARCHAR(64);
  v_existing_transfer RECORD;
BEGIN
  -- 1. Проверка идемпотентности
  IF p_idempotency_key IS NOT NULL AND p_idempotency_key <> '' THEN
    SELECT * INTO v_existing_transfer FROM public.cash_transfers WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'idempotent', true,
        'transfer_id', v_existing_transfer.id,
        'source_expense_id', v_existing_transfer.source_expense_id,
        'destination_payment_id', v_existing_transfer.destination_payment_id,
        'source_reference', (SELECT reference FROM public.expenses WHERE id = v_existing_transfer.source_expense_id),
        'destination_reference', (SELECT reference FROM public.payments WHERE id = v_existing_transfer.destination_payment_id),
        'amount_usd', v_existing_transfer.amount_usd,
        'status', v_existing_transfer.status
      );
    END IF;
  END IF;

  -- 2. Проверка касс
  IF p_source_cash_desk_id = p_destination_cash_desk_id THEN
    RAISE EXCEPTION 'SOURCE_AND_DESTINATION_MUST_BE_DIFFERENT';
  END IF;

  SELECT * INTO v_source_desk FROM public.dictionaries WHERE id = p_source_cash_desk_id AND type = 'CASH_DESK';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOURCE_CASH_DESK_NOT_FOUND';
  END IF;

  SELECT * INTO v_dest_desk FROM public.dictionaries WHERE id = p_destination_cash_desk_id AND type = 'CASH_DESK';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DESTINATION_CASH_DESK_NOT_FOUND';
  END IF;

  -- 3. Проверка и фиксация сумм и курсов
  IF p_currency = 'TJS' THEN
    IF p_amount_tjs IS NULL OR p_amount_tjs <= 0 THEN
      RAISE EXCEPTION 'INVALID_TJS_AMOUNT';
    END IF;
    IF p_exchange_rate IS NULL OR p_exchange_rate <= 0 THEN
      RAISE EXCEPTION 'INVALID_EXCHANGE_RATE';
    END IF;
    v_final_amount_tjs := ROUND(p_amount_tjs, 2);
    v_final_exchange_rate := p_exchange_rate;
    v_final_amount_usd := ROUND(p_amount_tjs / p_exchange_rate, 2);
  ELSE
    IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
      RAISE EXCEPTION 'INVALID_USD_AMOUNT';
    END IF;
    v_final_amount_usd := ROUND(p_amount_usd, 2);
    v_final_amount_tjs := NULL;
    v_final_exchange_rate := NULL;
  END IF;

  v_amount_minor := (v_final_amount_usd * 100)::BIGINT;

  -- 4. Проверка достаточности остатка кассы-источника (только ACTIVE)
  SELECT COALESCE(SUM(amount_minor), 0) / 100.0 INTO v_source_income
  FROM public.payments
  WHERE (cash_desk_id = p_source_cash_desk_id OR (cash_desk_id IS NULL AND comment ILIKE '%' || v_source_desk.name || '%'))
    AND status = 'ACTIVE'
    AND currency = 'USD';

  SELECT COALESCE(SUM(amount_minor), 0) / 100.0 INTO v_source_expense
  FROM public.expenses
  WHERE (cash_desk_id = p_source_cash_desk_id OR (cash_desk_id IS NULL AND description ILIKE '%' || v_source_desk.name || '%'))
    AND status = 'ACTIVE'
    AND currency = 'USD';

  v_available_balance := v_source_income - v_source_expense;

  IF v_available_balance < v_final_amount_usd THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS: Available USD % is less than requested USD %', v_available_balance, v_final_amount_usd;
  END IF;

  -- 5. Генерация уникального transfer_id
  v_transfer_id := gen_random_uuid();

  -- 6. Создание РКО кассы-источника с получением ID из sequence (без MAX(id)+1)
  INSERT INTO public.expenses (
    amount_minor,
    expense_date,
    category,
    description,
    created_by_user_id,
    created_at,
    currency,
    method,
    reference,
    recipient,
    exchange_rate,
    amount_usd,
    amount_tjs,
    cash_desk_id,
    transfer_id,
    status,
    operation_type
  ) VALUES (
    v_amount_minor,
    p_transfer_date,
    'Внутренние перемещения между кассами',
    '[Касса: ' || v_source_desk.name || '] Внутреннее перемещение: ' || COALESCE(p_description, 'Перемещение средств') || ' • в кассу: ' || v_dest_desk.name,
    p_user_id,
    NOW(),
    'USD',
    'CASH',
    'TEMP_REF',
    v_dest_desk.name,
    v_final_exchange_rate,
    v_final_amount_usd,
    v_final_amount_tjs,
    p_source_cash_desk_id,
    v_transfer_id,
    'ACTIVE',
    COALESCE(p_operation_type, 'INTERNAL_CASH_TRANSFER')
  ) RETURNING id INTO v_expense_id;

  v_rko_ref := 'РКО-ПЕРЕМ-' || v_expense_id;
  UPDATE public.expenses SET reference = v_rko_ref WHERE id = v_expense_id;

  -- 7. Создание ПКО кассы-получателя с получением ID из sequence (без MAX(id)+1)
  INSERT INTO public.payments (
    deal_id,
    schedule_id,
    amount_minor,
    payment_date,
    method,
    reference,
    comment,
    created_by_user_id,
    created_at,
    currency,
    payer_name,
    cash_desk_id,
    transfer_id,
    status,
    operation_type,
    amount_tjs,
    amount_usd,
    exchange_rate
  ) VALUES (
    NULL,
    NULL,
    v_amount_minor,
    p_transfer_date::TEXT,
    'CASH',
    'TEMP_REF',
    '[Касса: ' || v_dest_desk.name || '] Внутреннее перемещение: ' || COALESCE(p_description, 'Поступление средств') || ' • из кассы: ' || v_source_desk.name,
    p_user_id,
    NOW(),
    'USD',
    v_source_desk.name,
    p_destination_cash_desk_id,
    v_transfer_id,
    'ACTIVE',
    COALESCE(p_operation_type, 'INTERNAL_CASH_TRANSFER'),
    v_final_amount_tjs,
    v_final_amount_usd,
    v_final_exchange_rate
  ) RETURNING id INTO v_payment_id;

  v_pko_ref := 'ПКО-ПЕРЕМ-' || v_payment_id;
  UPDATE public.payments SET reference = v_pko_ref WHERE id = v_payment_id;

  -- 8. Создание мастер-записи cash_transfers
  INSERT INTO public.cash_transfers (
    id,
    operation_type,
    source_cash_desk_id,
    destination_cash_desk_id,
    source_expense_id,
    destination_payment_id,
    currency,
    amount_minor,
    amount_tjs,
    amount_usd,
    exchange_rate,
    recipient,
    description,
    status,
    idempotency_key,
    created_by,
    created_at
  ) VALUES (
    v_transfer_id,
    COALESCE(p_operation_type, 'INTERNAL_CASH_TRANSFER'),
    p_source_cash_desk_id,
    p_destination_cash_desk_id,
    v_expense_id,
    v_payment_id,
    p_currency,
    v_amount_minor,
    v_final_amount_tjs,
    v_final_amount_usd,
    v_final_exchange_rate,
    p_recipient,
    p_description,
    'ACTIVE',
    p_idempotency_key,
    p_user_id,
    NOW()
  );

  -- 9. Возврат результата
  RETURN jsonb_build_object(
    'success', true,
    'transfer_id', v_transfer_id,
    'source_expense_id', v_expense_id,
    'destination_payment_id', v_payment_id,
    'source_reference', v_rko_ref,
    'destination_reference', v_pko_ref,
    'amount_usd', v_final_amount_usd,
    'amount_tjs', v_final_amount_tjs,
    'exchange_rate', v_final_exchange_rate,
    'status', 'ACTIVE'
  );
END;
$$;

-- Права доступа для create_atomic_cash_transfer
REVOKE EXECUTE ON FUNCTION public.create_atomic_cash_transfer(UUID, UUID, VARCHAR, VARCHAR, NUMERIC, NUMERIC, NUMERIC, DATE, VARCHAR, TEXT, VARCHAR, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_atomic_cash_transfer(UUID, UUID, VARCHAR, VARCHAR, NUMERIC, NUMERIC, NUMERIC, DATE, VARCHAR, TEXT, VARCHAR, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_atomic_cash_transfer(UUID, UUID, VARCHAR, VARCHAR, NUMERIC, NUMERIC, NUMERIC, DATE, VARCHAR, TEXT, VARCHAR, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_atomic_cash_transfer(UUID, UUID, VARCHAR, VARCHAR, NUMERIC, NUMERIC, NUMERIC, DATE, VARCHAR, TEXT, VARCHAR, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_atomic_cash_transfer(UUID, UUID, VARCHAR, VARCHAR, NUMERIC, NUMERIC, NUMERIC, DATE, VARCHAR, TEXT, VARCHAR, INT) TO postgres;

-- 5. Атомарная функция create_atomic_expense с валидацией, двойной проверкой идемпотентности и FOR UPDATE
CREATE OR REPLACE FUNCTION public.create_atomic_expense(
  p_cash_desk_id UUID,
  p_amount_minor BIGINT,
  p_currency VARCHAR,
  p_expense_date DATE,
  p_category VARCHAR,
  p_recipient VARCHAR,
  p_description TEXT,
  p_user_id INT,
  p_method VARCHAR DEFAULT 'CASH',
  p_exchange_rate NUMERIC DEFAULT NULL,
  p_amount_usd NUMERIC DEFAULT NULL,
  p_amount_tjs NUMERIC DEFAULT NULL,
  p_idempotency_key VARCHAR DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_expense RECORD;
  v_desk RECORD;
  v_user RECORD;
  v_current_income NUMERIC(14,2);
  v_current_expense NUMERIC(14,2);
  v_current_balance NUMERIC(14,2);
  v_request_amount NUMERIC(14,2);
  v_expense_id INT;
  v_ref VARCHAR(64);
BEGIN
  -- 0. Обязательная валидация параметров RPC
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: Параметр idempotency_key обязателен для создания РКО';
  END IF;

  IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: Сумма операции должна быть строго больше нуля';
  END IF;

  IF p_currency IS NULL OR p_currency NOT IN ('USD', 'TJS') THEN
    RAISE EXCEPTION 'INVALID_CURRENCY: Разрешены только валюты USD и TJS. Получено: %', p_currency;
  END IF;

  -- Проверка существования пользователя
  SELECT * INTO v_user FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: Пользователь id=% не найден', p_user_id;
  END IF;

  -- Проверка согласованности amount_usd, amount_tjs и exchange_rate
  IF p_currency = 'USD' THEN
    IF p_amount_usd IS NOT NULL AND ROUND(p_amount_usd * 100) <> p_amount_minor THEN
      RAISE EXCEPTION 'AMOUNT_MISMATCH: amount_usd (%) не соответствует amount_minor (%)', p_amount_usd, p_amount_minor;
    END IF;
  ELSIF p_currency = 'TJS' THEN
    IF p_amount_tjs IS NOT NULL AND ROUND(p_amount_tjs * 100) <> p_amount_minor THEN
      RAISE EXCEPTION 'AMOUNT_MISMATCH: amount_tjs (%) не соответствует amount_minor (%)', p_amount_tjs, p_amount_minor;
    END IF;
    IF p_exchange_rate IS NOT NULL AND p_exchange_rate <= 0 THEN
      RAISE EXCEPTION 'INVALID_EXCHANGE_RATE: Курс обмена должен быть положительным';
    END IF;
  END IF;

  -- 1. Первичная проверка идемпотентности ДО захвата блокировки кассы
  SELECT * INTO v_existing_expense FROM public.expenses WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotent', true,
      'expense_id', v_existing_expense.id,
      'reference', v_existing_expense.reference,
      'cash_desk_id', v_existing_expense.cash_desk_id,
      'amount', (v_existing_expense.amount_minor / 100.0),
      'currency', v_existing_expense.currency,
      'balance_after', NULL
    );
  END IF;

  -- 2. Захват блокировки кассы FOR UPDATE (сериализация параллельных операций к кассе)
  SELECT * INTO v_desk 
  FROM public.dictionaries 
  WHERE id = p_cash_desk_id AND type = 'CASH_DESK' 
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASH_DESK_NOT_FOUND: Касса с id=% не найдена', p_cash_desk_id;
  END IF;

  -- 3. ПОВТОРНАЯ проверка идемпотентности ПОСЛЕ получения блокировки FOR UPDATE!
  -- Гарантирует, что параллельный запрос, завершившийся во время ожидания блокировки, не приведет к дублированию
  SELECT * INTO v_existing_expense FROM public.expenses WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotent', true,
      'expense_id', v_existing_expense.id,
      'reference', v_existing_expense.reference,
      'cash_desk_id', v_existing_expense.cash_desk_id,
      'amount', (v_existing_expense.amount_minor / 100.0),
      'currency', v_existing_expense.currency,
      'balance_after', NULL
    );
  END IF;

  v_request_amount := (p_amount_minor / 100.0);

  -- 4. Расчет текущего баланса кассы менеджера (только ACTIVE)
  SELECT COALESCE(SUM(amount_minor), 0) / 100.0 INTO v_current_income
  FROM public.payments
  WHERE cash_desk_id = p_cash_desk_id
    AND status = 'ACTIVE'
    AND currency = p_currency;

  SELECT COALESCE(SUM(amount_minor), 0) / 100.0 INTO v_current_expense
  FROM public.expenses
  WHERE cash_desk_id = p_cash_desk_id
    AND status = 'ACTIVE'
    AND currency = p_currency;

  v_current_balance := v_current_income - v_current_expense;

  -- 5. Проверка достаточности средств
  IF v_current_balance < v_request_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS: Недостаточно средств в кассе. Доступно: % %, запрошено: % %', v_current_balance, p_currency, v_request_amount, p_currency;
  END IF;

  -- 6. Безопасная вставка с получением sequence ID и перехватом unique constraint
  BEGIN
    INSERT INTO public.expenses (
      cash_desk_id,
      amount_minor,
      currency,
      expense_date,
      category,
      recipient,
      description,
      created_by_user_id,
      method,
      reference,
      exchange_rate,
      amount_usd,
      amount_tjs,
      status,
      operation_type,
      idempotency_key,
      created_at
    ) VALUES (
      p_cash_desk_id,
      p_amount_minor,
      p_currency,
      p_expense_date,
      COALESCE(p_category, 'Прочее'),
      p_recipient,
      p_description,
      p_user_id,
      COALESCE(p_method, 'CASH'),
      'TEMP_REF',
      p_exchange_rate,
      p_amount_usd,
      p_amount_tjs,
      'ACTIVE',
      'STANDARD',
      p_idempotency_key,
      NOW()
    ) RETURNING id INTO v_expense_id;
  EXCEPTION WHEN unique_violation THEN
    -- Если параллельный процесс вставил запись с тем же idempotency_key
    SELECT * INTO v_existing_expense FROM public.expenses WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'idempotent', true,
        'expense_id', v_existing_expense.id,
        'reference', v_existing_expense.reference,
        'cash_desk_id', v_existing_expense.cash_desk_id,
        'amount', (v_existing_expense.amount_minor / 100.0),
        'currency', v_existing_expense.currency,
        'balance_after', NULL
      );
    END IF;
  END;

  -- 7. Формирование reference на основе уникального sequence ID (без MAX(id)+1)
  v_ref := 'РКО-' || v_expense_id;
  UPDATE public.expenses SET reference = v_ref WHERE id = v_expense_id;

  RETURN jsonb_build_object(
    'success', true,
    'idempotent', false,
    'expense_id', v_expense_id,
    'reference', v_ref,
    'cash_desk_id', p_cash_desk_id,
    'amount', v_request_amount,
    'currency', p_currency,
    'balance_after', v_current_balance - v_request_amount
  );
END;
$$;

-- Права доступа для create_atomic_expense
REVOKE EXECUTE ON FUNCTION public.create_atomic_expense(UUID, BIGINT, VARCHAR, DATE, VARCHAR, VARCHAR, TEXT, INT, VARCHAR, NUMERIC, NUMERIC, NUMERIC, VARCHAR) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_atomic_expense(UUID, BIGINT, VARCHAR, DATE, VARCHAR, VARCHAR, TEXT, INT, VARCHAR, NUMERIC, NUMERIC, NUMERIC, VARCHAR) FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_atomic_expense(UUID, BIGINT, VARCHAR, DATE, VARCHAR, VARCHAR, TEXT, INT, VARCHAR, NUMERIC, NUMERIC, NUMERIC, VARCHAR) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_atomic_expense(UUID, BIGINT, VARCHAR, DATE, VARCHAR, VARCHAR, TEXT, INT, VARCHAR, NUMERIC, NUMERIC, NUMERIC, VARCHAR) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_atomic_expense(UUID, BIGINT, VARCHAR, DATE, VARCHAR, VARCHAR, TEXT, INT, VARCHAR, NUMERIC, NUMERIC, NUMERIC, VARCHAR) TO postgres;

COMMIT;
