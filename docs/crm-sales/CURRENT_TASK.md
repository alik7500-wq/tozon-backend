# CURRENT_TASK.md

- **ID задачи:** `GAP-01.1` — Завершение конкурентной безопасности распределения и проверки пула
- **Статус:** `DONE` (PGlite + unit: `071_r09_2_gap01_distribution.test.js` 7/7 + `sales_launch_phase3_6_concurrency.test.js` 23/23 + `persistent_distribution_settings` 12/12 + `071_r09_1_1` 5/5 + `070` 6/6 + `068` 8/8 + `066` 5/5 + `062` 7/7 = 8 файлов, 73/73 `PASS`; 2-процессный тест на реальной PostgreSQL `verify-gap01-two-process-pg.mjs` — `NOT_RUN` без `TEST_DATABASE_URL`)
- **Ветки:**
  - `alik7500-wq/tozon-backend`: `feat/crm-sales-completion`
  - `alik7500-wq/tozon-crm`: `a00` (без изменений)
- **Что сделано:**
  - Миграция `072_r09_2_gap01_1_cross_project_capacity_and_pool_backoff.sql`: единый порядок блокировок (`leads -> lead_distribution_settings -> users ORDER BY id ASC FOR UPDATE`) для защиты вместимости менеджера между разными проектами без deadlock; канонический подсчёт открытых лидов (исключены `LOST`, `SIGNED`, архив и `SIGNED`-сделки); безопасная проверка `v_has_settings` без SQL-ошибки для лида без проекта при пустых настройках; `pool_next_attempt_at` + `pool_attempts` + индекс `idx_leads_pool_due` для исключения голодания пула.
  - `RoundRobinService.resolveAssignment`: убран автовыбор менеджера в JS (без `leadId` возвращает `DEFERRED_TO_ATOMIC`, с `leadId` вызывает `assignLeadAtomic`).
  - `verify-gap01-two-process-pg.mjs`: полноценный воспроизводимый 2-процессный тест на синтетических данных с барьером старта, проверкой кросс-проектной гонки, manual-vs-auto и двух воркеров пула.
  - `sales_launch_phase3_6_concurrency.test.js`: 5 устаревших проверок обновлены под реальное бизнес-поведение (23/23 `PASS`).

## Следующая задача
- Закрытие оставшихся `P0`-блокеров из [R09_2_REQUIREMENTS_AUDIT.md](file:///d:/tozon-crm/server/docs/crm-sales/R09_2_REQUIREMENTS_AUDIT.md): `GAP-05`, `GAP-07`, `GAP-08`.
