# HANDOFF_R04.md — Фильтры, счётчики и пагинация

- **Задача:** `R04`
- **Статус:** `DONE` (PGlite DB/validator + UI mock тесты пройдены; staging API — `NOT_RUN`; сохранение догруженных страниц при автообновлении передано в `R07`)
- **Репозитории / Ветки:**
  - `alik7500-wq/tozon-backend`: `feat/crm-sales-completion`
  - `alik7500-wq/tozon-crm`: `a00`

## Изменения
- **Backend:**
  - `server/src/db/migrations/064_unified_lead_query_and_cursor.sql` — `fn_query_leads_unified(p_filters, p_scope)` (в БД: канонический этап от `deals`, `NO_TASK`/`PAUSED`/`OVERDUE` без дублей на `JOIN`, `[from, to)` в `Asia/Dushanbe`, keyset-курсор `(created_at_ts DESC, id DESC)`, полный `total`, `stats`, `stage_counts`, принудительный RBAC).
  - `server/src/modules/leads/leadFilterValidator.js` — whitelist-валидация фильтров (ошибка `400` на неизвестные параметры), кодирование и проверка курсора с `filterHash`.
  - `server/src/modules/leads/leads.repository.js` (`queryUnified`) и `leads.router.js` (`GET /`, `GET /stats`, `GET /export`).
  - `server/src/modules/leads/__tests__/064_unified_query_cursor.test.js` — PGlite-тесты (>page, одинаковые `created_at`, вставка между страницами, `SIGNED` vs legacy `WON`, `[from, to)`, `PAUSED` vs `NO_TASK`, `SALES_MANAGER` scope, невалидные фильтры/курсор).
- **Frontend:**
  - `client/src/features/leads/LeadsPage.jsx` — единый `buildUnifiedFilterParams` для `/leads`, `/leads/stats`, `/leads/export`, фильтры `taskState`, `archive`, `unread`, кнопка `Экспорт CSV`.
  - `client/src/features/leads/LeadKanbanView.jsx` — отображение полных `stageCounts` на каждой колонке.
  - `client/src/features/leads/__tests__/LeadsWorkspaceCompletion.test.jsx` — UI mock тест единых фильтров и `stageCounts`.

## Ограничения и передача в R07
- Проверено на изолированном PGlite + UI mocks; прогон на live staging БД/API — `NOT_RUN`.
- Сохранение догруженных страниц при фоновом автообновлении передано в `R07`.
