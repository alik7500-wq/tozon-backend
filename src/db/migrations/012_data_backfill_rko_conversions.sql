-- 012_data_backfill_rko_conversions.sql
-- Data migration: Link historical TJS expenses that had automatic USD->TJS conversion to their source conversions

-- 1. РКО-921220 (id=143) linked to КОНВ-20351 (id=142)
UPDATE expenses 
SET 
  exchange_rate = 9.27,
  amount_usd = 1510.25,
  conversion_expense_id = 142
WHERE id = 143 
  AND reference = 'РКО-921220'
  AND (conversion_expense_id IS NULL OR exchange_rate IS NULL);

-- 2. РКО-385704 (id=145) linked to КОНВ-84888 (id=144)
UPDATE expenses 
SET 
  exchange_rate = 9.27,
  amount_usd = 64.72,
  conversion_expense_id = 144
WHERE id = 145 
  AND reference = 'РКО-385704'
  AND (conversion_expense_id IS NULL OR exchange_rate IS NULL);
