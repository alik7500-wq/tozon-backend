-- Migration: 019_add_deal_snapshot_and_exchange_rate.sql
-- Description: Add deal snapshot fields (deal_price_per_m2_minor, exchange_rate) to deals table
--              and backfill existing deals to fix contract price calculations.

BEGIN;

-- 1. Add deal_price_per_m2_minor and exchange_rate to deals table
ALTER TABLE deals 
ADD COLUMN IF NOT EXISTS deal_price_per_m2_minor BIGINT,
ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(10, 4) DEFAULT 9.2900;

-- 2. Backfill deal_price_per_m2_minor for existing deals where area > 0
-- Calculated as: ROUND(final_price_minor / (area_m2_x100 / 100.0))
UPDATE deals d
SET deal_price_per_m2_minor = ROUND(d.final_price_minor / (u.area_m2_x100 / 100.0))
FROM units u
WHERE d.unit_id = u.id 
  AND u.area_m2_x100 > 0 
  AND (d.deal_price_per_m2_minor IS NULL OR d.deal_price_per_m2_minor = 0);

-- Specifically ensure deal #36 (contract 0026, unit 134) has 55000 (550.00 USD/m²)
UPDATE deals
SET deal_price_per_m2_minor = 55000,
    exchange_rate = 9.2900
WHERE contract_number = '0026' OR id = 36;

COMMIT;
