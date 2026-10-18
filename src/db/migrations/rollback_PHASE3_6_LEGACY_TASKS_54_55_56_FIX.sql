-- =============================================================================
-- Rollback Script for PHASE3_6_LEGACY_TASKS_54_55_56_FIX.sql
-- Purpose:
--   Restores tasks 54, 55, 56 back to status 'OPEN' if pre-release rollback is required.
-- Mode: LOCAL DEFINITION (Prepared for rollback reference if needed)
-- =============================================================================

BEGIN;

UPDATE public.tasks
SET status = 'OPEN',
    description = REPLACE(description, ' [ТЕХНИЧЕСКИЙ ДУБЛИКАТ: Отменено в рамках Phase 3.6 FIX от 18.10.2026. Первичная задача №31 сохранена в OPEN]', ''),
    updated_at = NOW()
WHERE id IN (54, 55, 56)
  AND lead_id = 46
  AND status = 'CANCELLED';

COMMIT;
