-- Migration: 018_create_atomic_payment_rpc.sql
-- Description: Идеальная атомарная PostgreSQL RPC-функция create_atomic_payment
--              со всеми валютными реквизитами, валидацией данных,
--              расширенным контролем конфликта параметров по 10 полям (IDEMPOTENCY_KEY_CONFLICT),
--              перехватом unique_violation, типом DATE и безопасным SET search_path = ''.

BEGIN;

CREATE OR REPLACE FUNCTION public.create_atomic_payment(
  p_deal_id INT,
  p_schedule_id INT DEFAULT NULL,
  p_amount_minor INT DEFAULT NULL,
  p_payment_date DATE DEFAULT NULL,
  p_method TEXT DEFAULT 'CASH',
  p_reference TEXT DEFAULT NULL,
  p_comment TEXT DEFAULT NULL,
  p_cash_desk_id UUID DEFAULT NULL,
  p_created_by_user_id INT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL,
  p_currency TEXT DEFAULT 'USD',
  p_payer_name TEXT DEFAULT NULL,
  p_amount_tjs NUMERIC DEFAULT NULL,
  p_amount_usd NUMERIC DEFAULT NULL,
  p_exchange_rate NUMERIC DEFAULT NULL
)
RETURNS TABLE (
  payment_id INT,
  is_duplicate BOOLEAN,
  created_new BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing_id INT;
  v_ex_deal INT;
  v_ex_sched INT;
  v_ex_amount INT;
  v_ex_date DATE;
  v_ex_desk UUID;
  v_ex_user INT;
  v_ex_curr TEXT;
  v_ex_tjs NUMERIC;
  v_ex_usd NUMERIC;
  v_ex_rate NUMERIC;

  v_deal_check INT;
  v_desk_check UUID;
  v_user_check INT;

  v_sched_id INT;
  v_sched_amount INT;
  v_sched_paid INT;

  v_new_paid INT;
  v_new_status TEXT;
  v_new_payment_id INT;
BEGIN
  -- 1. Валидация входных параметров
  IF p_idempotency_key IS NULL OR trim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: Ключ идемпотентности обязателен для проведения ПКО';
  END IF;

  IF p_payment_date IS NULL THEN
    RAISE EXCEPTION 'INVALID_DATE: Дата платежа обязательна (p_payment_date IS NOT NULL)';
  END IF;

  IF p_currency IS NULL OR p_currency NOT IN ('USD', 'TJS') THEN
    RAISE EXCEPTION 'INVALID_CURRENCY: Валюта должна быть USD или TJS';
  END IF;

  IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: Сумма ПКО должна быть больше нуля';
  END IF;

  IF p_exchange_rate IS NOT NULL AND p_exchange_rate <= 0 THEN
    RAISE EXCEPTION 'INVALID_EXCHANGE_RATE: Курс обмена должен быть больше нуля';
  END IF;

  IF (p_amount_tjs IS NOT NULL AND p_amount_tjs < 0) OR (p_amount_usd IS NOT NULL AND p_amount_usd < 0) THEN
    RAISE EXCEPTION 'INVALID_AMOUNT_CURRENCY: Сумма в валюте не может быть отрицательной';
  END IF;

  IF p_amount_tjs IS NOT NULL AND p_amount_usd IS NOT NULL AND p_exchange_rate IS NOT NULL AND p_exchange_rate > 0 THEN
    IF ABS(p_amount_usd * p_exchange_rate - p_amount_tjs) > 0.01 THEN
      RAISE EXCEPTION 'CURRENCY_MISMATCH: Несоответствие сумм TJS, USD и курса обмена (превышена погрешность 0.01)';
    END IF;
  END IF;

  -- 2. Первая проверка идемпотентности по 10 финансово значимым полям до блокировки
  SELECT p.id, p.deal_id, p.schedule_id, p.amount_minor, p.payment_date, p.cash_desk_id, p.created_by_user_id, p.currency, p.amount_tjs, p.amount_usd, p.exchange_rate
  INTO v_existing_id, v_ex_deal, v_ex_sched, v_ex_amount, v_ex_date, v_ex_desk, v_ex_user, v_ex_curr, v_ex_tjs, v_ex_usd, v_ex_rate
  FROM public.payments p
  WHERE p.idempotency_key = p_idempotency_key;

  IF v_existing_id IS NOT NULL THEN
    IF v_ex_deal IS DISTINCT FROM p_deal_id OR
       v_ex_sched IS DISTINCT FROM p_schedule_id OR
       v_ex_amount IS DISTINCT FROM p_amount_minor OR
       v_ex_date IS DISTINCT FROM p_payment_date OR
       v_ex_desk IS DISTINCT FROM p_cash_desk_id OR
       v_ex_user IS DISTINCT FROM p_created_by_user_id OR
       v_ex_curr IS DISTINCT FROM p_currency OR
       v_ex_tjs IS DISTINCT FROM p_amount_tjs OR
       v_ex_usd IS DISTINCT FROM p_amount_usd OR
       v_ex_rate IS DISTINCT FROM p_exchange_rate THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_CONFLICT: Ключ идемпотентности уже использован с другими параметрами платежа';
    END IF;

    RETURN QUERY SELECT v_existing_id, true, false;
    RETURN;
  END IF;

  -- 3. Проверки существования базовых сущностей
  SELECT id INTO v_deal_check FROM public.deals WHERE id = p_deal_id;
  IF v_deal_check IS NULL THEN
    RAISE EXCEPTION 'DEAL_NOT_FOUND: Сделка #% не найдена', p_deal_id;
  END IF;

  SELECT id INTO v_desk_check FROM public.dictionaries WHERE id = p_cash_desk_id AND type = 'CASH_DESK';
  IF v_desk_check IS NULL THEN
    RAISE EXCEPTION 'CASH_DESK_NOT_FOUND: Выбранная касса не найдена';
  END IF;

  SELECT id INTO v_user_check FROM public.users WHERE id = p_created_by_user_id;
  IF v_user_check IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: Пользователь #% не найден', p_created_by_user_id;
  END IF;

  -- 4. Пессимистическая блокировка строки графика через FOR UPDATE
  IF p_schedule_id IS NOT NULL THEN
    SELECT id, amount_minor, paid_amount_minor
    INTO v_sched_id, v_sched_amount, v_sched_paid
    FROM public.deal_payment_schedules
    WHERE id = p_schedule_id AND deal_id = p_deal_id
    FOR UPDATE;

    IF v_sched_id IS NULL THEN
      RAISE EXCEPTION 'SCHEDULE_NOT_FOUND: График #% не найден для сделки #%', p_schedule_id, p_deal_id;
    END IF;
  END IF;

  -- 5. Повторная проверка идемпотентности ПОСЛЕ блокировки FOR UPDATE по 10 полям
  SELECT p.id, p.deal_id, p.schedule_id, p.amount_minor, p.payment_date, p.cash_desk_id, p.created_by_user_id, p.currency, p.amount_tjs, p.amount_usd, p.exchange_rate
  INTO v_existing_id, v_ex_deal, v_ex_sched, v_ex_amount, v_ex_date, v_ex_desk, v_ex_user, v_ex_curr, v_ex_tjs, v_ex_usd, v_ex_rate
  FROM public.payments p
  WHERE p.idempotency_key = p_idempotency_key;

  IF v_existing_id IS NOT NULL THEN
    IF v_ex_deal IS DISTINCT FROM p_deal_id OR
       v_ex_sched IS DISTINCT FROM p_schedule_id OR
       v_ex_amount IS DISTINCT FROM p_amount_minor OR
       v_ex_date IS DISTINCT FROM p_payment_date OR
       v_ex_desk IS DISTINCT FROM p_cash_desk_id OR
       v_ex_user IS DISTINCT FROM p_created_by_user_id OR
       v_ex_curr IS DISTINCT FROM p_currency OR
       v_ex_tjs IS DISTINCT FROM p_amount_tjs OR
       v_ex_usd IS DISTINCT FROM p_amount_usd OR
       v_ex_rate IS DISTINCT FROM p_exchange_rate THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_CONFLICT: Ключ идемпотентности уже использован с другими параметрами платежа';
    END IF;

    RETURN QUERY SELECT v_existing_id, true, false;
    RETURN;
  END IF;

  -- 6. Вставка ПКО во вложенном блоке с перехватом unique_violation
  BEGIN
    INSERT INTO public.payments (
      deal_id, schedule_id, amount_minor, payment_date, method, reference, comment,
      cash_desk_id, created_by_user_id, idempotency_key, created_at, status,
      currency, payer_name, amount_tjs, amount_usd, exchange_rate
    ) VALUES (
      p_deal_id, p_schedule_id, p_amount_minor, p_payment_date, COALESCE(p_method, 'CASH'), p_reference, p_comment,
      p_cash_desk_id, p_created_by_user_id, p_idempotency_key, NOW(), 'ACTIVE',
      p_currency, p_payer_name, p_amount_tjs, p_amount_usd, p_exchange_rate
    ) RETURNING id INTO v_new_payment_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT p.id, p.deal_id, p.schedule_id, p.amount_minor, p.payment_date, p.cash_desk_id, p.created_by_user_id, p.currency, p.amount_tjs, p.amount_usd, p.exchange_rate
    INTO v_existing_id, v_ex_deal, v_ex_sched, v_ex_amount, v_ex_date, v_ex_desk, v_ex_user, v_ex_curr, v_ex_tjs, v_ex_usd, v_ex_rate
    FROM public.payments p
    WHERE p.idempotency_key = p_idempotency_key;

    IF v_existing_id IS NOT NULL THEN
      IF v_ex_deal IS DISTINCT FROM p_deal_id OR
         v_ex_sched IS DISTINCT FROM p_schedule_id OR
         v_ex_amount IS DISTINCT FROM p_amount_minor OR
         v_ex_date IS DISTINCT FROM p_payment_date OR
         v_ex_desk IS DISTINCT FROM p_cash_desk_id OR
         v_ex_user IS DISTINCT FROM p_created_by_user_id OR
         v_ex_curr IS DISTINCT FROM p_currency OR
         v_ex_tjs IS DISTINCT FROM p_amount_tjs OR
         v_ex_usd IS DISTINCT FROM p_amount_usd OR
         v_ex_rate IS DISTINCT FROM p_exchange_rate THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_CONFLICT: Ключ идемпотентности уже использован с другими параметрами платежа';
      END IF;

      RETURN QUERY SELECT v_existing_id, true, false;
      RETURN;
    ELSE
      RAISE;
    END IF;
  END;

  -- 7. Обновление графика платежей только при успешной новой вставке
  IF p_schedule_id IS NOT NULL AND v_sched_id IS NOT NULL THEN
    v_new_paid := COALESCE(v_sched_paid, 0) + p_amount_minor;
    v_new_status := CASE WHEN v_new_paid >= v_sched_amount THEN 'PAID' ELSE 'PARTIAL' END;

    UPDATE public.deal_payment_schedules
    SET paid_amount_minor = v_new_paid,
        status = v_new_status,
        updated_at = NOW()
    WHERE id = p_schedule_id;
  END IF;

  RETURN QUERY SELECT v_new_payment_id, false, true;
END;
$$;

-- Настройка безопасных прав вызова RPC
REVOKE EXECUTE ON FUNCTION public.create_atomic_payment(INT, INT, INT, DATE, TEXT, TEXT, TEXT, UUID, INT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_atomic_payment(INT, INT, INT, DATE, TEXT, TEXT, TEXT, UUID, INT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC) TO service_role, postgres;

COMMIT;
