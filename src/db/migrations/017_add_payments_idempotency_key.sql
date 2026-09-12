-- Migration: 017_add_payments_idempotency_key.sql
-- Description: Добавление колонки idempotency_key и UNIQUE-ограничения в таблицу payments
--              для обеспечения гарантированной идемпотентности ПКО на уровне PostgreSQL.

BEGIN;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_idempotency_key_key'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_idempotency_key_key UNIQUE (idempotency_key);
  END IF;
END $$;

COMMIT;
