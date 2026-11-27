# CURRENT_TASK.md

- **ID задачи:** `GAP-07` — Совместимый откат приложения с сохранением данных (`060`–`074`)
- **Статус:** `DONE` (`077_gap07_compatible_rollback.test.js` + `060_crm_sales_completion_foundation.test.js` + `060_pre_release_isolation.test.js` `PASS` в PGlite; прогон на реальной PostgreSQL / PostgREST `verify-gap07-rollback-pg.mjs` — `NOT_RUN`)
- **Ветки:**
  - `alik7500-wq/tozon-backend`: `feat/crm-sales-completion` (базовая точка отката `origin/main`: `261018ef557e54fbcfd0b31475fcb538c164201f`)
- **Что сделано:**
  - Инвентаризированы миграции `060`–`074`, зафиксированы совместимые сочетания версий приложения и схемы, ограничения и условия безопасного возобновления обработчиков в [R09_GAP07_ROLLBACK_RUNBOOK.md](file:///d:/tozon-crm/server/docs/crm-sales/R09_GAP07_ROLLBACK_RUNBOOK.md).
  - Добавлен идемпотентный неразрушающий скрипт отката приложения [app_rollback_060_074_preserve_data.sql](file:///d:/tozon-crm/server/src/db/migrations/app_rollback_060_074_preserve_data.sql): отключает фоновые воркеры и правила, освобождает активные `PROCESSING` lease без удаления очереди, выравнивает `leads.status` по `SIGNED`-сделкам (legacy `WON` без `SIGNED` → `NEGOTIATION`), переподтверждает закрытые `GRANT`/`RLS`.
  - Добавлен полный PGlite-тест цикла `077_gap07_compatible_rollback.test.js` и скрипт для одноразовой PostgreSQL / PostgREST `verify-gap07-rollback-pg.mjs`.

## Следующая задача
- `R09.3` — Общий прогон и регрессия backend + frontend (все `P0`-блокеры `GAP-01`, `GAP-05`, `GAP-07`, `GAP-08` закрыты в изолированной среде).
