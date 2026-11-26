# CURRENT_TASK.md

- **ID задачи:** `R08.1` — Завершение бизнес-обработчиков и защиты эффектов outbox
- **Статус:** `DONE` (PGlite worker + `fn_apply_outbox_effect` + регрессия R03/R04.2 `20/20 PASS`; проверка двумя независимыми процессами на реальном PostgreSQL — `NOT_RUN` из-за отсутствия среды)
- **Ветки:**
  - `tozon-backend`: `feat/crm-sales-completion`
  - `tozon-crm`: `a00` (без изменений в `R08.1`)
- **Что сделано:**
  - Миграция `069_outbox_atomic_effect_guard.sql`:
    - Добавлена настройка `crm_outbox_settings.process_historical_import BOOLEAN NOT NULL DEFAULT FALSE`.
    - Добавлена единая транзакционная RPC `fn_apply_outbox_effect(...)`: в одной транзакции проверяет активный `lease_token` и `lease_expires_at > NOW()`, состояние лида, наличие закрывающего `SIGNED`-договора в `deals` (даже при устаревшем `leads.stage`), ожидаемого ответственного и проектный допуск, после чего идемпотентно записывает `tasks`, `user_notifications` и `crm_automation_executions`.
  - `OutboxWorkerService` (`outboxWorker.service.js`):
    - Обязательная первичная задача (`PRIMARY_FIRST_CONTACT`, `event_ref = lead_primary_<id>`) создаётся ровно 1 раз для `LEAD_CREATED`/`LEAD_ASSIGNED` по регламенту `calculateSalesSlaDeadline(..., 15)` даже при выключенных дополнительных правилах; `COMMUNICATION_LOGGED` (`NO_ANSWER`/`BUSY`/`callback_at`) планирует перезвон по рабочему календарю.
    - Проверка `project_id`, `source_code` и `conditions_json`; неподдержанные `action_type` отправляются в карантин (`UNSUPPORTED_RULE_ACTION`) и никогда не получают `EXECUTED`; пропуски фиксируются как `SKIPPED`.
    - `LEAD_IMPORTED` / `is_historical_import` по умолчанию пропускается без свежих SLA/уведомлений/автозадач.
    - Согласованы `OUTBOX_WORKER_ENABLED` и `crm_outbox_settings.is_enabled` (`isOutboxWorkerActive()` + `misconfiguredWarning` в диагностике).
  - Добавлены тесты `R08.1` в `068_outbox_worker.test.js` (8/8 `PASS`).

## Следующая задача
- `R09` — Финальная стабилизация (включая транзакционную замену проектных прав `UsersRepository.setProjectAccess`).
