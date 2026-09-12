-- 022_fix_conversions_and_void_historical_set.sql
-- CONTROLLED PRODUCTION CASH BALANCE FIX (PHASE 2)
-- 
-- 1. СХЕМА: Добавление устойчивой связи conversion_id в payments и expenses
-- 2. АУДИТ: Фиксация snapshot затрагиваемых строк в finance_audit_backups
-- 3. GUARD CHECKS: Строгая валидация исходного состояния данных перед модификацией
-- 4. ВОССТАНОВЛЕНИЕ ПКО: #203 (3 500 TJS), #205 (51 380 TJS), #209 (41 380 TJS)
-- 5. ПРИВЯЗКА ПАР КОНВЕРТАЦИЙ: #325 <-> #203, #328 <-> #205, #338 <-> #209
-- 6. АННУЛИРОВАНИЕ ДУБЛЕЙ: expenses #87 и #93 (VOIDED)
-- 7. СОХРАНЕНИЕ ТРАНСФЕРОВ: 54, 88, 94 и 127, 128, 129 остаются ACTIVE
-- 8. ИНВАРИАНТ-КОНТРОЛЬ: Проверка результатов перед фиксацией транзакции

BEGIN;

-- ============================================================================
-- 1. СХЕМА: Добавление полей связи
-- ============================================================================
ALTER TABLE payments 
  ADD COLUMN IF NOT EXISTS conversion_id UUID;

ALTER TABLE expenses 
  ADD COLUMN IF NOT EXISTS conversion_id UUID;

CREATE INDEX IF NOT EXISTS idx_payments_conversion_id ON payments(conversion_id);
CREATE INDEX IF NOT EXISTS idx_expenses_conversion_id ON expenses(conversion_id);

-- ============================================================================
-- 2. АУДИТ: Снимок строк до изменений
-- ============================================================================
INSERT INTO finance_audit_backups (
  batch_id, 
  table_name, 
  record_id, 
  previous_status, 
  amount_minor,
  currency,
  full_snapshot, 
  backed_up_at
)
SELECT 
  'AUDIT_BEFORE_FIX_CONVERSIONS_AND_VOID_8_20260912',
  'payments',
  id,
  status,
  amount_minor,
  currency,
  to_jsonb(p),
  NOW()
FROM payments p
WHERE id IN (203, 205, 209);

INSERT INTO finance_audit_backups (
  batch_id, 
  table_name, 
  record_id, 
  previous_status, 
  amount_minor,
  currency,
  full_snapshot, 
  backed_up_at
)
SELECT 
  'AUDIT_BEFORE_FIX_CONVERSIONS_AND_VOID_8_20260912',
  'expenses',
  id,
  status,
  amount_minor,
  currency,
  to_jsonb(e),
  NOW()
FROM expenses e
WHERE id IN (87, 93, 325, 328, 338);

-- ============================================================================
-- 3–8. ГВАРД-ПРОВЕРКИ, КОРРЕКТИРОВКИ И ИНВАРИАНТ-ВАЛИДАЦИЯ
-- ============================================================================
DO $$
DECLARE
  v_rec_p203 RECORD;
  v_rec_p205 RECORD;
  v_rec_p209 RECORD;
  v_rec_e325 RECORD;
  v_rec_e328 RECORD;
  v_rec_e338 RECORD;
  v_rec_e87  RECORD;
  v_rec_e93  RECORD;

  v_conv1 UUID := 'c0000000-0000-0000-0000-000000000325'::UUID;
  v_conv2 UUID := 'c0000000-0000-0000-0000-000000000328'::UUID;
  v_conv3 UUID := 'c0000000-0000-0000-0000-000000000338'::UUID;

  v_active_transfers_count INT;
BEGIN
  -- --------------------------------------------------------------------------
  -- GUARD 1: Проверка PKO конвертаций #203, #205, #209
  -- --------------------------------------------------------------------------
  SELECT * INTO v_rec_p203 FROM payments WHERE id = 203;
  IF NOT FOUND OR v_rec_p203.currency <> 'TJS' OR v_rec_p203.status <> 'ACTIVE' OR v_rec_p203.amount_minor <> 4137998 THEN
    RAISE EXCEPTION 'GUARD FAILURE: payment #203 does not match expected state (found amount_minor: %, status: %, currency: %)',
      v_rec_p203.amount_minor, v_rec_p203.status, v_rec_p203.currency;
  END IF;

  SELECT * INTO v_rec_p205 FROM payments WHERE id = 205;
  IF NOT FOUND OR v_rec_p205.currency <> 'TJS' OR v_rec_p205.status <> 'ACTIVE' OR v_rec_p205.amount_minor <> 4137998 THEN
    RAISE EXCEPTION 'GUARD FAILURE: payment #205 does not match expected state (found amount_minor: %, status: %, currency: %)',
      v_rec_p205.amount_minor, v_rec_p205.status, v_rec_p205.currency;
  END IF;

  SELECT * INTO v_rec_p209 FROM payments WHERE id = 209;
  IF NOT FOUND OR v_rec_p209.currency <> 'TJS' OR v_rec_p209.status <> 'ACTIVE' OR v_rec_p209.amount_minor <> 4137998 THEN
    RAISE EXCEPTION 'GUARD FAILURE: payment #209 does not match expected state (found amount_minor: %, status: %, currency: %)',
      v_rec_p209.amount_minor, v_rec_p209.status, v_rec_p209.currency;
  END IF;

  -- --------------------------------------------------------------------------
  -- GUARD 2: Проверка RKO конвертаций #325, #328, #338
  -- --------------------------------------------------------------------------
  SELECT * INTO v_rec_e325 FROM expenses WHERE id = 325;
  IF NOT FOUND OR v_rec_e325.currency <> 'USD' OR v_rec_e325.status <> 'ACTIVE' OR v_rec_e325.amount_minor <> 37756 THEN
    RAISE EXCEPTION 'GUARD FAILURE: expense #325 does not match expected state';
  END IF;

  SELECT * INTO v_rec_e328 FROM expenses WHERE id = 328;
  IF NOT FOUND OR v_rec_e328.currency <> 'USD' OR v_rec_e328.status <> 'ACTIVE' OR v_rec_e328.amount_minor <> 554261 THEN
    RAISE EXCEPTION 'GUARD FAILURE: expense #328 does not match expected state';
  END IF;

  SELECT * INTO v_rec_e338 FROM expenses WHERE id = 338;
  IF NOT FOUND OR v_rec_e338.currency <> 'USD' OR v_rec_e338.status <> 'ACTIVE' OR v_rec_e338.amount_minor <> 446386 THEN
    RAISE EXCEPTION 'GUARD FAILURE: expense #338 does not match expected state';
  END IF;

  -- --------------------------------------------------------------------------
  -- GUARD 3: Проверка дублей расходов #87 и #93
  -- --------------------------------------------------------------------------
  SELECT * INTO v_rec_e87 FROM expenses WHERE id = 87;
  IF NOT FOUND OR v_rec_e87.currency <> 'USD' OR v_rec_e87.status <> 'ACTIVE' OR v_rec_e87.amount_minor <> 161638 
     OR v_rec_e87.cash_desk_id <> 'ab90800a-73af-4cf7-88c2-397c304e2edf' THEN
    RAISE EXCEPTION 'GUARD FAILURE: expense #87 does not match expected state';
  END IF;

  SELECT * INTO v_rec_e93 FROM expenses WHERE id = 93;
  IF NOT FOUND OR v_rec_e93.currency <> 'USD' OR v_rec_e93.status <> 'ACTIVE' OR v_rec_e93.amount_minor <> 150000 
     OR v_rec_e93.cash_desk_id <> 'ab90800a-73af-4cf7-88c2-397c304e2edf' THEN
    RAISE EXCEPTION 'GUARD FAILURE: expense #93 does not match expected state';
  END IF;

  -- --------------------------------------------------------------------------
  -- GUARD 4: Проверка, что 3 пары трансферов (54, 88, 94 и 127, 128, 129) сейчас ACTIVE
  -- --------------------------------------------------------------------------
  SELECT COUNT(*) INTO v_active_transfers_count 
  FROM (
    SELECT id FROM expenses WHERE id IN (54, 88, 94) AND status = 'ACTIVE'
    UNION ALL
    SELECT id FROM payments WHERE id IN (127, 128, 129) AND status = 'ACTIVE'
  ) t;

  IF v_active_transfers_count <> 6 THEN
    RAISE EXCEPTION 'GUARD FAILURE: Not all 6 transfer records are in ACTIVE status (found: %)', v_active_transfers_count;
  END IF;

  -- ==========================================================================
  -- ВЫПОЛНЕНИЕ КОРРЕКТИРОВОК
  -- ==========================================================================

  -- 1. Корректировка и связывание пары 1 (#325 ↔ #203)
  UPDATE expenses 
  SET conversion_id = v_conv1, operation_type = 'CONVERSION' 
  WHERE id = 325;

  UPDATE payments 
  SET 
    amount_minor = 350000, 
    conversion_id = v_conv1, 
    operation_type = 'CONVERSION',
    comment = 'Поступление от обмена $377.56 USD по курсу 9.27 (РКО-325)'
  WHERE id = 203;

  -- 2. Корректировка и связывание пары 2 (#328 ↔ #205)
  UPDATE expenses 
  SET conversion_id = v_conv2, operation_type = 'CONVERSION' 
  WHERE id = 328;

  UPDATE payments 
  SET 
    amount_minor = 5138000, 
    conversion_id = v_conv2, 
    operation_type = 'CONVERSION',
    comment = 'Поступление от обмена $5542.61 USD по курсу 9.27 (РКО-328)'
  WHERE id = 205;

  -- 3. Корректировка и связывание пары 3 (#338 ↔ #209)
  UPDATE expenses 
  SET conversion_id = v_conv3, operation_type = 'CONVERSION' 
  WHERE id = 338;

  UPDATE payments 
  SET 
    amount_minor = 4138000, 
    conversion_id = v_conv3, 
    operation_type = 'CONVERSION',
    comment = 'Поступление от обмена $4463.86 USD по курсу 9.27 (РКО-338)'
  WHERE id = 209;

  -- 4. Аннулирование ТОЛЬКО 2 ложных дублей расходов
  UPDATE expenses 
  SET 
    status = 'VOIDED', 
    void_reason = 'DUPLICATE_EXPENSE_ALREADY_ACCOUNTED_IN_TRANSFER_PAIR', 
    voided_at = NOW(), 
    voided_by = 1 
  WHERE id IN (87, 93);

  -- ==========================================================================
  -- ИНВАРИАНТ-ВАЛИДАЦИЯ ПОСЛЕ ОБНОВЛЕНИЯ
  -- ==========================================================================
  IF (SELECT amount_minor FROM payments WHERE id = 203) <> 350000 THEN
    RAISE EXCEPTION 'POST-VALIDATION FAILURE: payment #203 amount is not 350000';
  END IF;

  IF (SELECT amount_minor FROM payments WHERE id = 205) <> 5138000 THEN
    RAISE EXCEPTION 'POST-VALIDATION FAILURE: payment #205 amount is not 5138000';
  END IF;

  IF (SELECT amount_minor FROM payments WHERE id = 209) <> 4138000 THEN
    RAISE EXCEPTION 'POST-VALIDATION FAILURE: payment #209 amount is not 4138000';
  END IF;

  IF (SELECT status FROM expenses WHERE id = 87) <> 'VOIDED' OR (SELECT status FROM expenses WHERE id = 93) <> 'VOIDED' THEN
    RAISE EXCEPTION 'POST-VALIDATION FAILURE: expenses #87 and #93 are not VOIDED';
  END IF;

  SELECT COUNT(*) INTO v_active_transfers_count 
  FROM (
    SELECT id FROM expenses WHERE id IN (54, 88, 94) AND status = 'ACTIVE'
    UNION ALL
    SELECT id FROM payments WHERE id IN (127, 128, 129) AND status = 'ACTIVE'
  ) t;

  IF v_active_transfers_count <> 6 THEN
    RAISE EXCEPTION 'POST-VALIDATION FAILURE: 6 transfer records are no longer all ACTIVE';
  END IF;

  RAISE NOTICE 'MIGRATION 022 APPLIED AND VERIFIED SUCCESSFULLY';
END $$;

COMMIT;
