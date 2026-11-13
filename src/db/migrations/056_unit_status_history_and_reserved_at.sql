-- =============================================================================
-- Migration: 056_unit_status_history_and_reserved_at.sql
-- Purpose:
--   1. Create `public.unit_status_history` to record exact timestamps and reasons
--      whenever a unit (`public.units`) changes status (AVAILABLE, RESERVED, SOLD, BLOCKED).
--   2. Add database trigger `trg_log_unit_status_change` on `public.units` so all
--      status transitions are automatically captured for exact historical inventory
--      reporting (safely handling `public.units.created_at` stored as TEXT).
--   3. Add `reserved_at TIMESTAMPTZ` to `public.deals` to track exact reservation
--      start time independently from contract signing date (`deal_date`), safely
--      converting historical TEXT timestamps without substituting `NOW()` for
--      missing or invalid historical values.
--   4. Enable strict Row Level Security (RLS) for `service_role` only.
-- NOTE: Do NOT run on production without explicit owner approval.
-- =============================================================================

BEGIN;

-- 0. Безопасная функция разбора текстовой даты/времени в TIMESTAMPTZ.
--    В production базе колонки deals.created_at и units.created_at имеют тип TEXT
--    (наследие миграции из SQLite). Функция возвращает NULL для пустых или
--    некорректных строк и НИКОГДА не подставляет текущую дату (NOW()) вместо
--    отсутствующих исторических данных.
CREATE OR REPLACE FUNCTION public.fn_safe_parse_timestamptz(p_val TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_clean TEXT;
BEGIN
  IF p_val IS NULL THEN
    RETURN NULL;
  END IF;

  v_clean := BTRIM(p_val);
  IF v_clean = '' OR LOWER(v_clean) IN ('null', 'undefined', 'nan', 'invalid date') THEN
    RETURN NULL;
  END IF;

  -- Допускаем только корректный формат ISO-8601 даты или даты-времени (YYYY-MM-DD...)
  IF v_clean !~ '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$' THEN
    RETURN NULL;
  END IF;

  RETURN v_clean::TIMESTAMPTZ;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

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

-- 2.1. Приоритет 1: Фактическая дата перевода в бронь из истории аудита сделок (deal_audit_logs)
UPDATE public.deals d
SET reserved_at = sub.first_reserve_at
FROM (
  SELECT
    deal_id,
    MIN(
      COALESCE(
        CASE
          WHEN action IN ('RESERVE', 'RESERVE_DEAL', 'CREATE_RESERVATION')
            THEN public.fn_safe_parse_timestamptz(created_at::TEXT)
          WHEN action = 'UPDATE_DEAL' AND (changes_json->'updates'->>'status') = 'RESERVED'
            THEN public.fn_safe_parse_timestamptz(created_at::TEXT)
          WHEN (changes_json->'old'->>'status') = 'RESERVED'
            THEN COALESCE(
              public.fn_safe_parse_timestamptz(changes_json->'old'->>'created_at'),
              public.fn_safe_parse_timestamptz(created_at::TEXT)
            )
          ELSE NULL
        END,
        NULL
      )
    ) AS first_reserve_at
  FROM public.deal_audit_logs
  WHERE deal_id IS NOT NULL
    AND (
      action IN ('RESERVE', 'RESERVE_DEAL', 'CREATE_RESERVATION')
      OR (action = 'UPDATE_DEAL' AND (changes_json->'updates'->>'status') = 'RESERVED')
      OR (changes_json->'old'->>'status') = 'RESERVED'
    )
  GROUP BY deal_id
) sub
WHERE d.id = sub.deal_id
  AND d.reserved_at IS NULL
  AND sub.first_reserve_at IS NOT NULL;

-- 2.2. Приоритет 2: Фактическая дата события RESERVATION_CREATED из журнала уведомлений (если таблица существует)
DO $$
BEGIN
  IF to_regclass('public.user_notifications') IS NOT NULL THEN
    UPDATE public.deals d
    SET reserved_at = sub.notif_reserve_at
    FROM (
      SELECT
        entity_id AS deal_id,
        MIN(public.fn_safe_parse_timestamptz(created_at::TEXT)) AS notif_reserve_at
      FROM public.user_notifications
      WHERE type = 'RESERVATION_CREATED'
        AND entity_type = 'DEAL'
        AND entity_id IS NOT NULL
      GROUP BY entity_id
    ) sub
    WHERE d.id = sub.deal_id
      AND d.reserved_at IS NULL
      AND sub.notif_reserve_at IS NOT NULL;
  END IF;
END $$;

-- 2.3. Приоритет 3: Для действующих броней (status = 'RESERVED') и сделок, прошедших
--      этап бронирования (у которых заполнено reservation_expires_at), используем
--      историческую дату создания записи (created_at), безопасно приведённую из TEXT в TIMESTAMPTZ.
--      Для прямых договоров без бронирования reserved_at остаётся NULL.
--      Если created_at пустой или некорректный — остаётся NULL (текущая дата НЕ подставляется).
UPDATE public.deals
SET reserved_at = public.fn_safe_parse_timestamptz(created_at::TEXT)
WHERE reserved_at IS NULL
  AND (
    status = 'RESERVED'
    OR NULLIF(BTRIM(COALESCE(reservation_expires_at::TEXT, '')), '') IS NOT NULL
  )
  AND (
    signed_at IS NULL
    OR public.fn_safe_parse_timestamptz(signed_at::TEXT) IS NULL
    OR public.fn_safe_parse_timestamptz(created_at::TEXT) <= public.fn_safe_parse_timestamptz(signed_at::TEXT)
  );

-- 3. Триггерная функция автоматического логирования смены статуса квартиры
-- SECURITY DEFINER гарантирует запись истории даже при включённом RLS на unit_status_history.
-- Безопасно приводит NEW.created_at (тип TEXT в public.units) к TIMESTAMPTZ.
CREATE OR REPLACE FUNCTION public.fn_log_unit_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.unit_status_history (unit_id, old_status, new_status, reason, changed_at)
    VALUES (
      NEW.id,
      NULL,
      NEW.status,
      'INITIAL_CREATE',
      COALESCE(public.fn_safe_parse_timestamptz(NEW.created_at::TEXT), NOW())
    );
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
