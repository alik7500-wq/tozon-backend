# CURRENT_TASK.md

- **ID задачи:** `GAP-08` — Точные дата и время задач (`due_at`, `due_date_only`, `Asia/Dushanbe`)
- **Статус:** `DONE` (`TasksPageDueTime.test.jsx` 3/3 + `vite build` + `076_gap08_task_due_time.test.js` 2/2 + `068` 8/8 + `070` 6/6 + `062` 7/7 `PASS`; браузерный E2E на staging — `NOT_RUN`)
- **Ветки:**
  - `alik7500-wq/tozon-crm`: `a00`
  - `alik7500-wq/tozon-backend`: `feat/crm-sales-completion`
- **Что сделано:**
  - Frontend (`a00`): добавлен `taskDueTime.js` (`Asia/Dushanbe` конвертация и расчёт просрочки), в `TasksPage.jsx` добавлены два режима срока («Дата и время» и «Только дата»), форма редактирования с сохранением исходного режима/времени и очисткой противоречивых полей при переключении режима, отображение `due_at` / `18:00 Asia/Dushanbe`.
  - Backend (`feat/crm-sales-completion`): в `TasksRepository` (`tasks.repository.js`) исправлена фильтрация `OVERDUE` (учитывает `due_at` и правило `18:00 Asia/Dushanbe` для `due_date_only`, исключает `COMPLETED`/`CANCELLED`), `due_date` при точном `due_at` вычисляется в `Asia/Dushanbe`, при `due_date_only=true` сбрасывается `due_at=null`.

## Следующая задача
- Закрытие последнего `P0`-блокера из [R09_2_REQUIREMENTS_AUDIT.md](file:///d:/tozon-crm/server/docs/crm-sales/R09_2_REQUIREMENTS_AUDIT.md): `GAP-07` (rollback-скрипты для миграций `062`–`074`) перед общим прогоном `R09.3`.
