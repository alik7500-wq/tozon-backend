-- =============================================================================
-- PHASE 3.6 — DEDICATED PRE-RELEASE RECONCILIATION SCRIPT
-- File: PHASE3_6_LEGACY_TASKS_54_55_56_FIX.sql
-- Purpose:
--   Gracefully reconcile confirmed technical duplicate tasks (IDs: 54, 55, 56)
--   for Lead ID 46 prior to applying Migration 052 unique indexes.
--
-- Safety & Governance Rules:
--   1. Modifies STRICTLY and ONLY tasks with IDs 54, 55, and 56.
--   2. Strict pre-validation: lead_id = 46, status = 'OPEN', type = 'CALL', title matching.
--   3. Validates that primary task #31 is present and remains in 'OPEN' status.
--   4. Validates zero associated deals (deal_id IS NULL) on target tasks.
--   5. Retains full audit history: sets status = 'CANCELLED' with explanation, DOES NOT DELETE.
--   6. Fails-secure: any precondition failure aborts entire transaction without partial changes.
--
-- Mode: PREPARED LOCAL DEFINITION. DO NOT EXECUTE ON PRODUCTION WITHOUT OWNER CONSENT.
-- =============================================================================

BEGIN;

DO $$
DECLARE
    v_task31_count INT;
    v_target_count INT;
    v_deal_count INT;
    v_rows_updated INT;
    v_task31_after INT;
BEGIN
    -- 1. PRE-CHECK: Confirm primary task #31 is intact, OPEN, and belongs to Lead 46
    SELECT COUNT(*)
    INTO v_task31_count
    FROM public.tasks
    WHERE id = 31
      AND lead_id = 46
      AND type = 'CALL'
      AND status = 'OPEN'
      AND title LIKE 'Первичный звонок:%';

    IF v_task31_count <> 1 THEN
        RAISE EXCEPTION 'PRE_CHECK_ABORT: Первичная задача #31 не найдена в ожидаемом состоянии (lead_id=46, status=OPEN, type=CALL). Найдено: %', v_task31_count;
    END IF;

    -- 2. PRE-CHECK: Confirm exactly 3 duplicate tasks exist with matching parameters
    SELECT COUNT(*)
    INTO v_target_count
    FROM public.tasks
    WHERE id IN (54, 55, 56)
      AND lead_id = 46
      AND type = 'CALL'
      AND status = 'OPEN'
      AND title LIKE 'Квалификация потребностей:%';

    IF v_target_count <> 3 THEN
        RAISE EXCEPTION 'PRE_CHECK_ABORT: Ожидалось ровно 3 открытых дубликата (54, 55, 56) для лида 46, найдено: %', v_target_count;
    END IF;

    -- 3. PRE-CHECK: Ensure no deals are linked to these tasks
    SELECT COUNT(*)
    INTO v_deal_count
    FROM public.tasks
    WHERE id IN (54, 55, 56)
      AND deal_id IS NOT NULL;

    IF v_deal_count > 0 THEN
        RAISE EXCEPTION 'PRE_CHECK_ABORT: Задачи 54, 55, 56 содержат deal_id, операция отменена во избежание повреждения финансовых связей.';
    END IF;

    -- 4. EXECUTE SAFE UPDATE: Transition duplicate tasks to CANCELLED without deletion
    UPDATE public.tasks
    SET status = 'CANCELLED',
        description = COALESCE(description, '') || ' [ТЕХНИЧЕСКИЙ ДУБЛИКАТ: Отменено в рамках Phase 3.6 FIX от 18.10.2026. Первичная задача №31 сохранена в OPEN]',
        updated_at = NOW()
    WHERE id IN (54, 55, 56)
      AND lead_id = 46
      AND status = 'OPEN'
      AND type = 'CALL';

    GET DIAGNOSTICS v_rows_updated = ROW_COUNT;

    IF v_rows_updated <> 3 THEN
        RAISE EXCEPTION 'POST_CHECK_ABORT: Ожидалось обновление ровно 3 строк, фактически обновлено: %. Транзакция откатана.', v_rows_updated;
    END IF;

    -- 5. POST-CHECK: Verify primary task #31 is STILL OPEN and unchanged
    SELECT COUNT(*)
    INTO v_task31_after
    FROM public.tasks
    WHERE id = 31
      AND status = 'OPEN'
      AND lead_id = 46;

    IF v_task31_after <> 1 THEN
        RAISE EXCEPTION 'POST_CHECK_ABORT: Первичная задача #31 была непреднамеренно затронута! Транзакция откатана.';
    END IF;

    RAISE NOTICE 'SUCCESS: Задачи 54, 55, 56 успешно переведены в CANCELLED. Первичная задача #31 сохранена в OPEN.';
END $$;

COMMIT;
