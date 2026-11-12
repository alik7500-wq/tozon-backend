-- =============================================================================
-- Migration: 056_unit_status_history_and_reserved_at.sql
-- Purpose:
--   1. Create `public.unit_status_history` to record exact timestamps and reasons
--      whenever a unit (`public.units`) changes status (AVAILABLE, RESERVED, SOLD, BLOCKED).
--   2. Add database trigger `trg_log_unit_status_change` on `public.units` so all
--      status transitions are automatically captured for exact historical inventory
--      reporting.
--   3. Add `reserved_at TIMESTAMPTZ` to `public.deals` to track exact reservation
--      start time independently from contract signing date (`deal_date`).
--   4. Enable strict Row Level Security (RLS) for `service_role` only.
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

-- Бэкфилл reserved_at из истории аудита сделок (RESERVE) или даты создания для активных броней
UPDATE public.deals d
SET reserved_at = sub.first_reserve_at
FROM (
  SELECT deal_id, MIN(created_at) AS first_reserve_at
  FROM public.deal_audit_logs
  WHERE action IN ('RESERVE', 'RESERVE_DEAL', 'CREATE_RESERVATION')
  GROUP BY deal_id
) sub
WHERE d.id = sub.deal_id AND d.reserved_at IS NULL;

UPDATE public.deals
SET reserved_at = created_at
WHERE status = 'RESERVED' AND reserved_at IS NULL;

-- 3. Триггерная функция автоматического логирования смены статуса квартиры
-- SECURITY DEFINER гарантирует запись истории даже при включённом RLS на unit_status_history
CREATE OR REPLACE FUNCTION public.fn_log_unit_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

-- 4. PostgreSQL Row Level Security (RLS) & Strict Role Permissions
ALTER TABLE public.unit_status_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.unit_status_history FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.unit_status_history_id_seq FROM PUBLIC, anon, authenticated;

GRANT ALL ON public.unit_status_history TO service_role, postgres;
GRANT USAGE, SELECT ON SEQUENCE public.unit_status_history_id_seq TO service_role, postgres;

DROP POLICY IF EXISTS unit_status_history_service_role ON public.unit_status_history;
CREATE POLICY unit_status_history_service_role ON public.unit_status_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
