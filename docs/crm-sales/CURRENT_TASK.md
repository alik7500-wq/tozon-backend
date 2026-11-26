# CURRENT_TASK.md

- **ID задачи:** `GAP-01.3` — Единый порядок блокировок для многопроектной партии пула
- **Статус:** `DONE` (PGlite + unit: `071_r09_2_gap01_distribution.test.js` 9/9 + `sales_launch_phase3_6_concurrency.test.js` 23/23 + `persistent_distribution_settings` 12/12 + `071_r09_1_1` 5/5 + `070` 6/6 + `068` 8/8 + `066` 5/5 + `062` 7/7 = 8 файлов, 75/75 `PASS`; 2-процессная проверка на реальной PostgreSQL `verify-gap01-two-process-pg.mjs` — `NOT_RUN`)
- **Ветки:**
  - `alik7500-wq/tozon-backend`: `feat/crm-sales-completion`
  - `alik7500-wq/tozon-crm`: `a00` (без изменений)
- **Что сделано:**
  - Миграция `074_r09_2_gap01_3_unified_lock_order_pool_batch.sql`: в `fn_run_lead_pool_batch` реализован единый предварительный захват блокировок: (1) вся партия `leads` (`FOR UPDATE OF l SKIP LOCKED` в `_tmp_pool_batch`), (2) `lead_distribution_settings` (`id = 1`, `project_id IS NULL` и все проектные настройки партии в `ORDER BY id ASC FOR UPDATE`), (3) активные `users` (`ORDER BY id ASC FOR UPDATE`), затем цикл `fn_select_and_assign_lead_atomic` и финальный `UPDATE` диагностики на `id = 1`.
  - `verify-gap01-two-process-pg.mjs`: добавлены детерминированные барьерные сценарии 5 и 6 (многопроектная партия пула против параллельного назначения проекта Б с удержанием `settings(B)` и финальное обновление `id = 1` против параллельного глобального назначения), установлены `statement_timeout`, `lock_timeout` и таймауты дочерних процессов с принудительным завершением до очистки. Без `TEST_DATABASE_URL` остаётся `NOT_RUN`.

## Следующая задача
- Закрытие оставшихся `P0`-блокеров из [R09_2_REQUIREMENTS_AUDIT.md](file:///d:/tozon-crm/server/docs/crm-sales/R09_2_REQUIREMENTS_AUDIT.md): `GAP-05`, `GAP-07`, `GAP-08`.
