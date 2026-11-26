# CURRENT_TASK.md

- **ID задачи:** `GAP-01` — Надёжное проектное распределение лидов и обработчик пула `unassigned`
- **Статус:** `DONE` (PGlite: `071_r09_2_gap01_distribution.test.js` 5/5 + `071_r09_1_1` 5/5 + `070` 6/6 + `068` 8/8 + `066` 5/5 + `062` 7/7 + `persistent_distribution_settings` 12/12 = 7 файлов, 48/48 `PASS`; 2-процессный staging PostgreSQL — `NOT_RUN`)
- **Ветки:**
  - `alik7500-wq/tozon-backend`: `feat/crm-sales-completion`
  - `alik7500-wq/tozon-crm`: `a00` (без изменений)
- **Что сделано:**
  - Миграция `071_r09_2_gap01_transactional_distribution.sql`: `fn_select_and_assign_lead_atomic` (проектный доступ, исключения, календарь, ёмкость, `round_robin_cursor` в БД, история, outbox в одной транзакции) и `fn_run_lead_pool_batch` (`pg_try_advisory_xact_lock`, пропуск архивных/`LOST`/`SIGNED`).
  - `RoundRobinService`: удалена подмена ошибок БД нулевой нагрузкой, добавлена фильтрация по `user_project_access`/`all_projects_access` и `assignLeadAtomic`.
  - `LeadPoolWorkerService`, `run-lead-pool-worker.js`, `GET /api/leads/distribution/pool-diagnostics`, `POST /api/leads/distribution/pool-run-once` (выключен по умолчанию).
  - `OutboxWorkerService`: фоновое назначение `LEAD_IMPORTED` не создаёт свежий SLA.
  - Обновлена матрица `R09_2_REQUIREMENTS_AUDIT.md` (`F-08`, `A10`–`A14`).

## Следующая задача
- Закрытие оставшихся `P0`-блокеров из [R09_2_REQUIREMENTS_AUDIT.md](file:///d:/tozon-crm/server/docs/crm-sales/R09_2_REQUIREMENTS_AUDIT.md): `GAP-05`, `GAP-07`, `GAP-08`.
