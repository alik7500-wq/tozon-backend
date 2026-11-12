-- =============================================================================
-- Migration: 056_unit_status_history_and_reserved_at.sql
-- Purpose:
--   1. Create `public.unit_status_history` to record exact timestamps and reasons
--      whenever a unit (`public.units`) changes status (FREE, RESERVED, SOLD, etc.).
--   2. Add database trigger `trg_log_unit_status_change` on `public.units` so all
--      status transitions are automatically captured for exact historical inventory
--      reporting.
--   3. Add `reserved_at TIMESTAMPTZ` to `public.deals` to track exact reservation
--      start time independently from contract signing date (`deal_date`).
-- NOTE: Do NOT run on production without explicit owner approval.
-- =============================================================================

BEGIN;

-- 1. Таблица истории статусов объектов недвижимости (квартир, коммерции, парковок)
CREATE TABLE IF NOT EXISTS public.unit_status_history (
  id BIGSERIAL PRIMARY KEY,
  unit_id BIGINT NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
  old_status TEXT,
  new_status TEXT NOT NULL,
  deal_id BIGINT REFERENCES public.deals(id) ON DELETE SET NULL,
  reason TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_unit_status_history_unit_changed
  ON public.unit_status_history(unit_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_unit_status_history_changed_at
  ON public.unit_status_history(changed_at);

-- 2. Поле точной даты/времени бронирования в сделке
ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS reserved_at TIMESTAMPTZ;

-- Бэкфилл reserved_at для существующих броней по дате создания сделки
UPDATE public.deals
SET reserved_at = created_at
WHERE status = 'RESERVED' AND reserved_at IS NULL;

-- 3. Триггерная функция автоматического логирования смены статуса квартиры
CREATE OR REPLACE FUNCTION public.fn_log_unit_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.unit_status_history (unit_id, old_status, new_status, reason, changed_at)
    VALUES (NEW.id, NULL, NEW.status, 'INITIAL_CREATE', COALESCE(NEW.created_at, NOW()));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO public.unit_status_history (unit_id, old_status, new_status, reason, changed_at)
    VALUES (NEW.id, OLD.status, NEW.status, 'STATUS_CHANGED', NOW());
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_unit_status_change ON public.units;

CREATE TRIGGER trg_log_unit_status_change
AFTER INSERT OR UPDATE OF status ON public.units
FOR EACH ROW
EXECUTE FUNCTION public.fn_log_unit_status_change();

COMMIT;
