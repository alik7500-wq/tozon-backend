# CURRENT_TASK.md

- **ID задачи:** `GAP-08.1` — Серверная согласованность и валидация сроков задач
- **Статус:** `DONE` (`TasksPageDueTime.test.jsx` 3/3 + `vite build` + `076_gap08_task_due_time.test.js` 4/4 + `068` 8/8 + `070` 6/6 + `062` 7/7 + `sales_launch_phase3_6_concurrency` 23/23 = 5 файлов, 48/48 `PASS`; браузерный E2E — `NOT_RUN`)
- **Ветки:**
  - `alik7500-wq/tozon-backend`: `feat/crm-sales-completion`
  - `alik7500-wq/tozon-crm`: `a00`
- **Что сделано:**
  - `TasksRepository` (`tasks.repository.js`): централизована функция `normalizeTaskDueFields` для `create` и `update`:
    - строгая валидация (`400 AppError`): `due_date_only` только `boolean`, корректная календарная дата `due_date`, `due_at` только с часовым поясом (`Z` или `±HH:MM`), запрет противоречий режимов (`due_date_only=true` с непустым `due_at`, `due_date_only=false` без `due_at`);
    - в точном режиме `due_at` — авторитетный источник (`due_date` вычисляется из `due_at` в `Asia/Dushanbe`); в режиме «Только дата» `due_at = null`;
    - частичное обновление (`title`/`description`) сохраняет существующий срок без изменений; частичное обновление срока учитывает сохранённый режим.
  - Frontend (`taskDueTime.js`, `TasksPage.jsx`): удалена тихая подстановка `'09:00'` при пустом/неверном времени в `dushanbeDateTimeToUtcIso`, добавлена пред-отправочная валидация и inline-ошибка до запроса.

## Следующая задача
- Закрытие последнего `P0`-блокера из [R09_2_REQUIREMENTS_AUDIT.md](file:///d:/tozon-crm/server/docs/crm-sales/R09_2_REQUIREMENTS_AUDIT.md): `GAP-07` (rollback-скрипты для миграций `062`–`074`) перед общим прогоном `R09.3`.
