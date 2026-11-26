# CURRENT_TASK.md

- **ID задачи:** `R04` — Фильтры, счётчики и пагинация
- **Статус:** `DONE` (PGlite DB-side query/cursor + UI mock тесты пройдены; сохранение догруженных страниц при фоновом автообновлении передано в `R07`; live staging — `NOT_RUN`)
- **Ветки:**
  - `tozon-backend`: `feat/crm-sales-completion`
  - `tozon-crm`: `a00`
- **Что сделано:**
  - Создана миграция `064_unified_lead_query_and_cursor.sql` (`public.fn_query_leads_unified`): единая фильтрация, полный `total`, `stats`, `stage_counts` и keyset-пагинация `(created_at_ts DESC, id DESC)` на стороне БД без загрузки всех строк в Node.js и без умножения строк на `JOIN` (`deals`/`tasks`).
  - Преобразование календарных дат `[from, to)` из `Asia/Dushanbe` в `UTC`, расчёт просрочки по `due_at` и концу рабочего дня (`18:00 Asia/Dushanbe`) для `due_date_only`, строгое различие `NO_TASK`, `PAUSED` и `AWAITING_RESPONSE`.
  - В `leadFilterValidator.js` реализована строгая валидация всех параметров и base64url-курсора с привязкой к `filterHash` (неподдержанные параметры и чужой курсор отклоняются с `400`).
  - `GET /api/leads`, `GET /api/leads/stats` и `GET /api/leads/export` используют единый `LeadsRepository.queryUnified`.
  - На frontend (`LeadsPage.jsx`, `LeadKanbanView.jsx`) добавлены фильтры `taskState`, `archive`, `unread`, кнопка `Экспорт CSV`, полные `stageCounts` на колонках доски и синхронная передача фильтров в `/leads`, `/leads/stats`, `/leads/export`.

## Передано в R07
- Сохранение догруженных по `nextCursor` страниц при фоновом периодическом автообновлении (сейчас фоновый `tick` запрашивает первую страницу) — решается в `R07`.

## Следующая задача
- `R05` — Доступ `SALES_MANAGER` к основной `InstagramInboxPage` и маршруту (в ветках `feat/crm-sales-completion` и `a00`).
