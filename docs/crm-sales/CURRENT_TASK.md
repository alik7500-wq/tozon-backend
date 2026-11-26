# CURRENT_TASK.md

- **ID задачи:** `R04.1` — Исправление замечаний к фильтрам, пагинации, доске, экспорту и scope проектов
- **Статус:** `DONE` (PGlite DB-side query/cursor + Supertest streaming export/board + UI mock тесты пройдены; сохранение догруженных страниц при фоновом автообновлении передано в `R07`; live staging — `NOT_RUN`)
- **Ветки:**
  - `tozon-backend`: `feat/crm-sales-completion`
  - `tozon-crm`: `a00`
- **Что сделано:**
  - Миграция `065_harden_unified_query_cursor_and_scope.sql`: точный микросекундный курсор `created_at_iso_us` (`YYYY-MM-DD"T"HH24:MI:SS.US"Z"`), fail-closed `has_all_projects` / `allowed_project_ids` (пустой/неизвестный scope ограниченной роли возвращает `0` строк), независимая порционная выборка `board_columns` через `board_per_stage_limit`.
  - В `leadFilterValidator.js` и `leads.repository.js`: сохранение микросекунд в курсоре без `Date.toISOString()`, валидация формата и диапазона курсора, per-column `nextCursor` с корректным `stageFilterHash`.
  - В `leads.router.js`: добавлен `GET /api/leads/board`; `GET /api/leads/export` переведён на потоковый экспорт Excel (`.xlsx` по умолчанию через `ExcelJS.stream.xlsx.WorkbookWriter`, опционально `?format=csv`) без тихой обрезки на 10 000 строках и с явным `413 EXPORT_LIMIT_EXCEEDED` при превышении `MAX_EXPORT_ROWS`.
  - На frontend (`LeadsPage.jsx`, `LeadKanbanView.jsx`): Kanban использует `GET /leads/board` и порционную догрузку каждой колонки (`Показать ещё` -> `/leads?stage=...&cursor=...`); кнопка экспорта переведена на `Экспорт Excel`.
  - Тесты: `064_unified_query_cursor.test.js` (6/6), `065_export_and_board_api.test.js` (4/4, включая 10 050 строк `.xlsx` и `csv` и `413`), `LeadsWorkspaceCompletion.test.jsx` (3/3).

## Передано в R07
- Сохранение догруженных по `nextCursor` страниц при фоновом периодическом автообновлении (сейчас фоновый `tick` запрашивает первую страницу) — решается в `R07`.

## Следующая задача
- `R05` — Доступ `SALES_MANAGER` к основной `InstagramInboxPage` и маршруту (в ветках `feat/crm-sales-completion` и `a00`).
