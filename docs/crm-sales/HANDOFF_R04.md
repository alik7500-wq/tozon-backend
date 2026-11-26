# HANDOFF_R04.md — R04 & R04.1: Фильтры, счётчики, доска, пагинация, экспорт и project scope

## Реализованные артефакты (R04 + R04.1)
- **Backend:**
  - `src/db/migrations/064_unified_lead_query_and_cursor.sql` — базовая единая функция `public.fn_query_leads_unified(p_filters JSONB, p_scope JSONB)`.
  - `src/db/migrations/065_harden_unified_query_cursor_and_scope.sql` — аддитивное обновление `public.fn_query_leads_unified`:
    - `created_at_iso_us` (`YYYY-MM-DD"T"HH24:MI:SS.US"Z"`) для точного микросекундного keyset-курсора;
    - fail-closed `has_all_projects` / `allowed_project_ids` (при `has_all_projects = false` и пустом/отсутствующем списке проектов возвращает `0` строк);
    - `board_per_stage_limit` для независимой порционной выборки по каждой из 9 канонических колонок (`board_columns`).
  - `src/modules/leads/leadFilterValidator.js` — сохранение микросекунд и `id_str` в курсоре, проверка формата/диапазона и `filterHash`, поддержка `boardPerStageLimit`, константа `MAX_EXPORT_ROWS`.
  - `src/modules/leads/leads.repository.js` — `LeadsRepository.queryUnified` с формированием `boardColumns` и per-column `nextCursor`.
  - `src/modules/leads/leads.router.js` — добавлен `GET /api/leads/board`; `GET /api/leads/export` переведён на потоковую отдачу `.xlsx` (по умолчанию, `ExcelJS.stream.xlsx.WorkbookWriter`) и `csv` (`?format=csv`) без тихого обрезания на 10 000 строках и с явным `413 EXPORT_LIMIT_EXCEEDED`.
  - Тесты: `064_unified_query_cursor.test.js` (PGlite), `065_export_and_board_api.test.js` (Supertest + ExcelJS).
- **Frontend:**
  - `src/features/leads/LeadsPage.jsx`, `src/features/leads/LeadKanbanView.jsx` — загрузка доски через `/leads/board`, независимая догрузка колонок (`Показать ещё`), кнопка `Экспорт Excel`.
  - Тесты: `src/features/leads/__tests__/LeadsWorkspaceCompletion.test.jsx`.

## Ограничения и статусы среды
- Локально: PGlite (`@electric-sql/pglite`), Vitest + Supertest (`server`) и Vite build + Vitest jsdom (`client`) — `PASS`.
- Live staging PostgreSQL: `NOT_RUN` (нет подключения к staging Supabase в среде выполнения).
- Примечание для `R07`: фоновый авто-refresh (`tick`) по-прежнему перезагружает первую страницу/снимок; сохранение догруженных курсором страниц при автообновлении выполняется в `R07`.
