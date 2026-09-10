-- 013_cash_sync_and_ground_truth.sql
-- Финальная синхронизация касс с эталонными данными Google Таблицы:
-- 1. Устранение отрицательного сальдо TJS и очистка фантомных записей автоконвертации
-- 2. Перепривязка ордера Бойматова ($10 000 USD) к Кассе компании "Тозон" (Илхомчон)
-- 3. Нормализация 3 внутренних перемещений ($3 337,90 USD) как парных проводок перемещения

-- 1. Удаление фантомных платежей автоконвертации в TJS, создававших рассинхронизацию
DELETE FROM payments 
WHERE id IN (112, 119, 120, 123, 124, 125, 130, 131)
   OR comment ILIKE '%Поступление от обмена%'
   OR comment ILIKE '%Поступление от автоконвертации%';

-- 2. Обнуление ссылок на удаляемые конвертационные расходы
UPDATE expenses 
SET conversion_expense_id = NULL 
WHERE conversion_expense_id IN (142, 144, 160, 162, 164, 166, 168, 170, 172);

-- 3. Удаление дублирующих расходов автоконвертации
DELETE FROM expenses 
WHERE id IN (142, 144, 160, 162, 164, 166, 168, 170, 172)
   OR category = 'Конвертация валюты' 
   AND description ILIKE 'Автоконвертация%';

-- 4. Приведение всех фактических расходов в сомони к списанию с баланса USD (как в Google Таблице)
--    с сохранением исторического курса и суммы в сомони в метаданных и описании
UPDATE expenses
SET 
  currency = 'USD',
  amount_minor = 151025,
  amount_usd = 1510.25,
  exchange_rate = 9.27
WHERE id = 143;

UPDATE expenses
SET 
  currency = 'USD',
  amount_minor = 6472,
  amount_usd = 64.72,
  exchange_rate = 9.27
WHERE id = 145;

UPDATE expenses
SET 
  currency = 'USD',
  amount_minor = 21575,
  amount_usd = 215.75,
  exchange_rate = 9.27
WHERE id = 161;

UPDATE expenses
SET 
  currency = 'USD',
  amount_minor = 3463,
  amount_usd = 34.63,
  exchange_rate = 9.27
WHERE id = 163;

UPDATE expenses
SET 
  currency = 'USD',
  amount_minor = 798722,
  amount_usd = 7987.22,
  exchange_rate = 9.39
WHERE id = 165;

UPDATE expenses
SET 
  currency = 'USD',
  amount_minor = 449521,
  amount_usd = 4495.21,
  exchange_rate = 9.39
WHERE id = 167;

UPDATE expenses
SET 
  currency = 'USD',
  amount_minor = 682004,
  amount_usd = 6820.04,
  exchange_rate = 9.38
WHERE id = 169;

UPDATE expenses
SET 
  currency = 'USD',
  amount_minor = 26969,
  amount_usd = 269.69,
  exchange_rate = 9.27
WHERE id = 171;

UPDATE expenses
SET 
  currency = 'USD',
  amount_minor = 5394,
  amount_usd = 53.94,
  exchange_rate = 9.27
WHERE id = 173;

-- 5. Перепривязка ПКО Бойматова ($10 000 USD) к кассе Илхомчона
UPDATE payments
SET 
  comment = '[Касса: Касса компании "Тозон" (Илхомчон)] [Раздел: TJS] • Внесено в кассу: 94000 TJS (Курс: 9.40)',
  payer_name = 'Бойматов Чамшед Косимович',
  reference = 'ПКО к дог. 0020'
WHERE id = 121;

-- 6. Нормализация 3 входящих внутренних перемещений ($3 337,90 USD)
-- ПКО в кассу Илхомчона:
UPDATE payments
SET 
  comment = '[Касса: Касса компании "Тозон" (Илхомчон)] Внутреннее перемещение: 2100 смн, МБТИ Абдухаким • из кассы: Касса Отдела продаж (Акмалхон)',
  payer_name = 'Акмалхон',
  reference = 'ПКО-ПЕРЕМ-221'
WHERE id = 127;

UPDATE payments
SET 
  comment = '[Касса: Касса компании "Тозон" (Илхомчон)] Внутреннее перемещение: Барои ичозати Экология 15000 смн. Курс 9,28 • из кассы: Касса Отдела продаж (Акмалхон)',
  payer_name = 'Акмалхон',
  reference = 'ПКО-ПЕРЕМ-1616'
WHERE id = 128;

UPDATE payments
SET 
  comment = '[Касса: Касса компании "Тозон" (Илхомчон)] Внутреннее перемещение: Барои тех.условия 60 Квт/час. 13950 смн курс 9,30 • из кассы: Касса Отдела продаж (Акмалхон)',
  payer_name = 'Акмалхон',
  reference = 'ПКО-ПЕРЕМ-1500'
WHERE id = 129;

-- РКО из кассы Акмалхона:
UPDATE expenses
SET 
  category = 'Внутренние перемещения между кассами',
  recipient = 'Касса компании "Тозон" (Илхомчон)',
  description = '[Касса: Касса Отдела продаж (Акмалхон)] Внутреннее перемещение: 2100 смн, МБТИ Абдухаким • в кассу: Касса компании "Тозон" (Илхомчон)',
  reference = 'РКО-ПЕРЕМ-221'
WHERE id = 54;

UPDATE expenses
SET 
  category = 'Внутренние перемещения между кассами',
  recipient = 'Касса компании "Тозон" (Илхомчон)',
  description = '[Касса: Касса Отдела продаж (Акмалхон)] Внутреннее перемещение: Барои ичозати Экология • в кассу: Касса компании "Тозон" (Илхомчон)',
  reference = 'РКО-ПЕРЕМ-1616'
WHERE id = 88;

UPDATE expenses
SET 
  category = 'Внутренние перемещения между кассами',
  recipient = 'Касса компании "Тозон" (Илхомчон)',
  description = '[Касса: Касса Отдела продаж (Акмалхон)] Внутреннее перемещение: Тех условия 60 кВт/час • в кассу: Касса компании "Тозон" (Илхомчон)',
  reference = 'РКО-ПЕРЕМ-1500'
WHERE id = 94;
