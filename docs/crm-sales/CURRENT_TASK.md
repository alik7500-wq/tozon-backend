# CURRENT_TASK.md

- **ID задачи:** `R08` — Реальный обработчик `crm_event_outbox` и восстановление после сбоев
- **Статус:** `DONE` (PGlite worker + triggers + atomic claim/ack + lease recovery + quarantine + cutoff tests `17/17 PASS`; проверка двумя независимыми процессами на реальном PostgreSQL — `NOT_RUN` из-за отсутствия среды)
- **Ветки:**
  - `tozon-backend`: `feat/crm-sales-completion`
  - `tozon-crm`: `a00` (без изменений в `R08`)
- **Что сделано:**
  - Миграция `068_outbox_worker_lease_and_controls.sql`:
    - Расширена `public.crm_event_outbox` (`lease_token`, `lease_expires_at`, `locked_by`, `quarantined_at`, `quarantine_reason`, `error_kind`, `replayed_by`, `replayed_at`).
    - Создана таблица настроек `public.crm_outbox_settings` (`is_enabled = FALSE` по умолчанию, `cutoff_at = NOW()`).
    - Добавлен уникальный индекс `uq_tasks_event_ref_rule` на `public.tasks(event_ref, rule_key)`.
    - Добавлены атомарные RPC `fn_claim_outbox_batch` (`FOR UPDATE SKIP LOCKED`, восстановление зависших `PROCESSING`) и `fn_complete_outbox_event` (проверка `lease_token`, backoff, автокарантин при исчерпании попыток).
    - Добавлены атомарные триггеры `trg_leads_enqueue_outbox`, `trg_lead_assignment_enqueue_outbox` и `trg_lead_comm_enqueue_outbox`.
  - В `leads.repository.js` старые прямые вызовы уведомлений/задач отключены при `OUTBOX_WORKER_ENABLED=true`.
  - Создан `OutboxWorkerService` (`server/src/modules/outbox/outboxWorker.service.js`), защищённый API `outbox.router.js` (`/api/outbox/*`) и CLI runner `server/src/scripts/run-outbox-worker.js` (production cron не включён).
  - Добавлены тесты `068_outbox_worker.test.js` (5/5 `PASS`).

## Следующая задача
- `R09` — Финальная стабилизация (включая транзакционную замену проектных прав `UsersRepository.setProjectAccess`).
