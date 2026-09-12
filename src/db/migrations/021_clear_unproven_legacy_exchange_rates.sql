-- Migration: 021_clear_unproven_legacy_exchange_rates.sql
-- Description: Remove default 9.2900 exchange rate column default and clear unproven legacy exchange_rate values.

BEGIN;

-- 1. Remove DEFAULT 9.2900 constraint from deals table
ALTER TABLE deals ALTER COLUMN exchange_rate DROP DEFAULT;

-- 2. Set exchange_rate = NULL for all legacy deals where it was set to 9.2900 by Migration 019
UPDATE deals
SET exchange_rate = NULL
WHERE exchange_rate = 9.2900;

COMMIT;
