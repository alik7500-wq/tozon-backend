# CURRENT_TASK.md

- **ID задачи:** `R03.1` — Закрытие оставшихся обходов атомарной смены этапа
- **Статус:** `DONE` (PGlite + unit/HTTP; фоновая доставка задач из `crm_event_outbox` реализуется в `R08`, проверка двумя независимыми процессами PostgreSQL — `NOT_RUN` без staging)
- **Ветка (`tozon-backend`):** `feat/crm-sales-completion`
- **Что сделано:**
  - Создана миграция `063_harden_stage_transition_and_task_cancel.sql`: канонический `jsonb_build_object(...)` fingerprint (включая `meeting_at`, `showing_*`, `actor_user_id`, `expected_version`), и при `LOST` отменяются строго открытые продажные задачи (`deal_id IS NULL`, исключая финансовые/договорные).
  - В `LeadsRepository.update` и `PUT/PATCH /api/leads/:id` закрыт обход изменения `status`/`stage` (явный `400`) и повторная запись `responsible_user_id` после `assignManager`.
  - В `leads.router.js` сохранено различие `409 IDEMPOTENCY_CONFLICT` vs `VERSION_CONFLICT`, убран дублирующий прямой вызов `TasksService.onLeadStatusChanged` (единственный путь — `crm_event_outbox`, worker в `R08`).

## Следующая задача
- `R04` — Фильтры, счётчики и пагинация (в ветках `feat/crm-sales-completion` и `a00`).
