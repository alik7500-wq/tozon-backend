-- 014_atomic_cash_transfers.sql
-- Перезапуск внутренних перемещений между кассами:
-- 1. Добавление структурированных полей в expenses и payments
-- 2. Создание таблицы cash_transfers
-- 3. Создание атомарной функции PostgreSQL RPC create_atomic_cash_transfer
-- 4. Аннулирование ошибочного комплекта из 8 записей на 3 337,90 USD

-- 1. Добавление колонок в expenses
ALTER TABLE expenses 
  ADD COLUMN IF NOT EXISTS cash_desk_id UUID REFERENCES dictionaries(id),
  ADD COLUMN IF NOT EXISTS transfer_id UUID,
  ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by INT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS operation_type VARCHAR(32) DEFAULT 'STANDARD',
  ADD COLUMN IF NOT EXISTS amount_tjs NUMERIC(14,2);

-- 2. Добавление колонок в payments
ALTER TABLE payments 
  ADD COLUMN IF NOT EXISTS cash_desk_id UUID REFERENCES dictionaries(id),
  ADD COLUMN IF NOT EXISTS transfer_id UUID,
  ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by INT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS operation_type VARCHAR(32) DEFAULT 'STANDARD',
  ADD COLUMN IF NOT EXISTS amount_tjs NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS amount_usd NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(12,6);

-- 3. Создание таблицы cash_transfers
CREATE TABLE IF NOT EXISTS cash_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_type VARCHAR(32) NOT NULL DEFAULT 'INTERNAL_CASH_TRANSFER',
  source_cash_desk_id UUID NOT NULL REFERENCES dictionaries(id),
  destination_cash_desk_id UUID NOT NULL REFERENCES dictionaries(id),
  source_expense_id INT REFERENCES expenses(id) ON DELETE SET NULL,
  destination_payment_id INT REFERENCES payments(id) ON DELETE SET NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  amount_minor BIGINT NOT NULL,
  amount_tjs NUMERIC(14,2),
  amount_usd NUMERIC(14,2) NOT NULL,
  exchange_rate NUMERIC(12,6),
  recipient VARCHAR(255),
  description TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  void_reason TEXT,
  voided_at TIMESTAMPTZ,
  voided_by INT REFERENCES users(id),
  idempotency_key VARCHAR(128) UNIQUE,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_transfers_different_desks CHECK (source_cash_desk_id <> destination_cash_desk_id),
  CONSTRAINT chk_transfers_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT chk_transfers_status CHECK (status IN ('ACTIVE', 'VOIDED'))
);

-- Индексы
CREATE INDEX IF NOT EXISTS idx_expenses_cash_desk_id ON expenses(cash_desk_id);
CREATE INDEX IF NOT EXISTS idx_payments_cash_desk_id ON payments(cash_desk_id);
CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses(status);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_expenses_transfer_id ON expenses(transfer_id);
CREATE INDEX IF NOT EXISTS idx_payments_transfer_id ON payments(transfer_id);
CREATE INDEX IF NOT EXISTS idx_cash_transfers_idempotency ON cash_transfers(idempotency_key);

-- 4. Атомарная хранимая функция создания внутреннего перемещения
CREATE OR REPLACE FUNCTION create_atomic_cash_transfer(
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
    SELECT * INTO v_existing_transfer FROM cash_transfers WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'idempotent', true,
        'transfer_id', v_existing_transfer.id,
        'source_expense_id', v_existing_transfer.source_expense_id,
        'destination_payment_id', v_existing_transfer.destination_payment_id,
        'amount_usd', v_existing_transfer.amount_usd,
        'status', v_existing_transfer.status
      );
    END IF;
  END IF;

  -- 2. Проверка касс
  IF p_source_cash_desk_id = p_destination_cash_desk_id THEN
    RAISE EXCEPTION 'SOURCE_AND_DESTINATION_MUST_BE_DIFFERENT';
  END IF;

  SELECT * INTO v_source_desk FROM dictionaries WHERE id = p_source_cash_desk_id AND type = 'CASH_DESK';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOURCE_CASH_DESK_NOT_FOUND';
  END IF;

  SELECT * INTO v_dest_desk FROM dictionaries WHERE id = p_destination_cash_desk_id AND type = 'CASH_DESK';
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
    -- Фиксация расчета USD ровно 1 раз
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
  -- Доходы кассы-источника
  SELECT COALESCE(SUM(amount_minor), 0) / 100.0 INTO v_source_income
  FROM payments
  WHERE (cash_desk_id = p_source_cash_desk_id OR (cash_desk_id IS NULL AND comment ILIKE '%' || v_source_desk.name || '%'))
    AND status = 'ACTIVE'
    AND currency = 'USD';

  -- Расходы кассы-источника
  SELECT COALESCE(SUM(amount_minor), 0) / 100.0 INTO v_source_expense
  FROM expenses
  WHERE (cash_desk_id = p_source_cash_desk_id OR (cash_desk_id IS NULL AND description ILIKE '%' || v_source_desk.name || '%'))
    AND status = 'ACTIVE'
    AND currency = 'USD';

  v_available_balance := v_source_income - v_source_expense;

  IF v_available_balance < v_final_amount_usd THEN
    RAISE EXCEPTION 'INSUFFICIENT_FUNDS: Available USD % is less than requested USD %', v_available_balance, v_final_amount_usd;
  END IF;

  -- 5. Генерация уникального transfer_id и номеров документов
  v_transfer_id := gen_random_uuid();
  v_next_rko_num := COALESCE((SELECT MAX(id) FROM expenses), 0) + 1;
  v_next_pko_num := COALESCE((SELECT MAX(id) FROM payments), 0) + 1;
  v_rko_ref := 'РКО-ПЕРЕМ-' || v_next_rko_num;
  v_pko_ref := 'ПКО-ПЕРЕМ-' || v_next_pko_num;

  -- 6. Создание РКО кассы-источника
  INSERT INTO expenses (
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
    v_rko_ref,
    v_dest_desk.name,
    v_final_exchange_rate,
    v_final_amount_usd,
    v_final_amount_tjs,
    p_source_cash_desk_id,
    v_transfer_id,
    'ACTIVE',
    COALESCE(p_operation_type, 'INTERNAL_CASH_TRANSFER')
  ) RETURNING id INTO v_expense_id;

  -- 7. Создание ПКО кассы-получателя
  INSERT INTO payments (
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
    v_pko_ref,
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

  -- 8. Создание мастер-записи cash_transfers
  INSERT INTO cash_transfers (
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

-- 5. Аннулирование ошибочного комплекта из 8 записей на 3 337,90 USD
UPDATE expenses
SET 
  status = 'VOIDED',
  void_reason = 'REENTERED_VIA_ATOMIC_CASH_TRANSFER',
  voided_at = NOW(),
  voided_by = 1
WHERE id IN (54, 87, 88, 93, 94);

UPDATE payments
SET 
  status = 'VOIDED',
  void_reason = 'REENTERED_VIA_ATOMIC_CASH_TRANSFER',
  voided_at = NOW(),
  voided_by = 1
WHERE id IN (127, 128, 129);
