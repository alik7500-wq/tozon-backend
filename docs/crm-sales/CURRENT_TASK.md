# CURRENT_TASK.md

- **ID задачи:** `R03` — Атомарная смена этапа лида
- **Статус:** `DONE` (на изолированной PGlite БД + unit/fail-closed; проверка двумя независимыми соединениями/процессами на live PostgreSQL — `NOT_RUN`, вынесена в staging-приёмку)
- **Ветка (`tozon-backend`):** `feat/crm-sales-completion`
- **Что сделано:**
  - Создана миграция `062_atomic_lead_stage_transition.sql`: атомарная функция `public.fn_update_lead_stage_atomic(...)` с `FOR UPDATE`, CAS-проверкой `p_expected_version`, `pg_advisory_xact_lock` по `p_idempotency_key`, проверкой реальных сделок (`deals`), записью `lead_stage_history` + `crm_event_outbox` + отменой задач при `LOST` в одной транзакции, без создания фиктивного `first_contact_at` и без затирания `responsible_user_id`.
  - В `LeadsRepository.updateStatus` и `LeadsRepository.assignManager` убран небезопасный обход через обычный `UPDATE` при ошибке RPC (fail-closed `503`).
  - В `leads.router.js` (`PATCH /:id/status`) добавлена передача `Idempotency-Key` и пропуск повторного `TasksService.onLeadStatusChanged` при `replayed: true`.

## Следующая задача
- `R04` — Фильтры, счётчики и пагинация (в ветках `feat/crm-sales-completion` и `a00`).
