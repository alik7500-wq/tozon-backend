# CURRENT_TASK.md

- **ID задачи:** `GAP-01.2` — Устранение инверсии блокировок пула, проектный доступ в `fn_assign_lead_atomic` и изоляция 2-процессного теста
- **Статус:** `DONE` (PGlite + unit: `071_r09_2_gap01_distribution.test.js` 8/8 + `sales_launch_phase3_6_concurrency.test.js` 23/23 + `persistent_distribution_settings` 12/12 + `071_r09_1_1` 5/5 + `070` 6/6 + `068` 8/8 + `066` 5/5 + `062` 7/7 = 8 файлов, 74/74 `PASS`; 2-процессная проверка на реальной PostgreSQL `verify-gap01-two-process-pg.mjs` — `NOT_RUN`)
- **Ветки:**
  - `alik7500-wq/tozon-backend`: `feat/crm-sales-completion`
  - `alik7500-wq/tozon-crm`: `a00` (без изменений)
- **Что сделано:**
  - Миграция `073_r09_2_gap01_2_pool_lock_order_and_manual_project_access.sql`:
    - `fn_run_lead_pool_batch` захватывает всю партию `leads` upfront (`_tmp_pool_batch` с `FOR UPDATE OF l SKIP LOCKED`) до любых блокировок `lead_distribution_settings`/`users` (единый порядок блокировок во всех путях, без утверждения о 2-процессном доказательстве до прогона на реальной PostgreSQL).
    - `fn_assign_lead_atomic` проверяет проектный доступ (`user_project_access` / `all_projects_access`) внутри транзакции для ручного и автоматического режимов (`PROJECT_ACCESS_DENIED` без изменения лида, истории и outbox; в `LeadsRepository.assignManager` маппится в `403`).
  - `verify-gap01-two-process-pg.mjs`: переведён на `TEST_DATABASE_URL`, IPC-барьер готовности, `allowed_user_ids` для изоляции кандидатов, гарантированное пересечение advisory lock и сценарий pool + concurrent lead hold.

## Следующая задача
- Закрытие оставшихся `P0`-блокеров из [R09_2_REQUIREMENTS_AUDIT.md](file:///d:/tozon-crm/server/docs/crm-sales/R09_2_REQUIREMENTS_AUDIT.md): `GAP-05`, `GAP-07`, `GAP-08`.
