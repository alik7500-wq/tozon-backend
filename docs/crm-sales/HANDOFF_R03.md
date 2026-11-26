# HANDOFF_R03.md — Атомарная смена этапа лида (обновлено по R03.1)

- **Задача:** `R03` + `R03.1`
- **Статус:** `DONE` (PGlite + unit/HTTP; доставка задач из outbox — в `R08`; 2 независимых процесса PostgreSQL — `NOT_RUN`)
- **Репозиторий / Ветка:** `alik7500-wq/tozon-backend` (`server/`), ветка `feat/crm-sales-completion`

## Изменения (R03 + R03.1)
- `server/src/db/migrations/062_atomic_lead_stage_transition.sql` — базовая атомарная RPC `fn_update_lead_stage_atomic`.
- `server/src/db/migrations/063_harden_stage_transition_and_task_cancel.sql` — следующая миграция: канонический `jsonb_build_object(...)` fingerprint (включая `meeting_at`, `showing_*`, `actor_user_id`, `expected_version`) и отмена строго продажных задач при `LOST` (сохраняются `deal_id IS NOT NULL` и финансовые/договорные задачи).
- `server/src/modules/leads/leads.repository.js` — whitelist `_prepareLeadEditData` в `update()`, отказ `400` при попытке передать `status`/`stage`, fail-closed `503` при ошибке RPC в `updateStatus` и `assignManager`.
- `server/src/modules/leads/leads.router.js` — единый `handleLeadProfileUpdate` для `PUT/PATCH /:id` (без обхода `status`/`stage` и без повторной записи `responsible_user_id`), различие `IDEMPOTENCY_CONFLICT` vs `VERSION_CONFLICT`, отказ от дублирующего прямого `TasksService.onLeadStatusChanged` в `PATCH /:id/status`.
- `server/src/modules/leads/__tests__/062_atomic_stage_transition.test.js` и `leadsRepositoryFailClosed.test.js`.

## Оставшиеся ограничения
- Запись события в `crm_event_outbox` при переходе этапа доказана в PGlite, но **фоновый обработчик доставки задач из outbox реализуется в `R08`** (сейчас доставка эффекта не завершена и не считается проверенной).
- Проверка двумя независимыми соединениями/процессами PostgreSQL: **NOT_RUN** (требуется staging PostgreSQL).
- Остаются задачи `R04`–`R09`.
