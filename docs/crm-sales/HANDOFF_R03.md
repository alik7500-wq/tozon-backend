# HANDOFF_R03.md — Атомарная смена этапа лида

- **Задача:** `R03`
- **Статус:** `DONE` (PGlite + unit/fail-closed; проверка двумя независимыми соединениями PostgreSQL — `NOT_RUN` без staging БД)
- **Репозиторий / Ветка:** `alik7500-wq/tozon-backend` (`server/`), ветка `feat/crm-sales-completion`

## Изменения
- `server/src/db/migrations/062_atomic_lead_stage_transition.sql` — следующая миграция: `lead_stage_history.idempotency_key` + `request_fingerprint`, функция `public.fn_update_lead_stage_atomic(...)` (`SECURITY DEFINER`, `SET search_path = public, pg_temp`, `EXECUTE` только для `service_role, postgres`).
- `server/src/modules/leads/leads.repository.js` — `updateStatus` и `assignManager` строго через атомарные RPC без обхода через обычный `UPDATE` при ошибке RPC (fail-closed `503`, `409` с `current`).
- `server/src/modules/leads/leads.router.js` — передача `Idempotency-Key` и защита от повторных побочных эффектов при `replayed: true`.
- `server/src/modules/leads/__tests__/062_atomic_stage_transition.test.js` — PGlite-тесты: конкурентные переходы, переход одновременно с назначением, идемпотентный replay + конфликт, откат при сбое триггером истории/outbox, запрещённые переходы и `anon` `EXECUTE`.
- `server/src/modules/leads/__tests__/leadsRepositoryFailClosed.test.js` — unit-тест fail-closed `503` и `403` для чужого лида.

## Проверки
- `npm.cmd --prefix server test -- src/modules/leads/__tests__/062_atomic_stage_transition.test.js src/modules/leads/__tests__/leadsRepositoryFailClosed.test.js src/modules/leads/__tests__/leadDomain.test.js` → **PASS** (3 файла, 12/12 тестов).

## Оставшиеся ограничения
- Проверка двумя независимыми соединениями/процессами PostgreSQL: **NOT_RUN** (в данной среде использован однопроцессный PGlite; подлежит обязательной проверке на staging PostgreSQL).
- Остаются задачи `R04`–`R09`.
