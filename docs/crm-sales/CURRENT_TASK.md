# CURRENT_TASK.md

- **ID задачи:** `R09.2` — Аудит полноты реализации исходного ТЗ (`TOZON_CRM_SALES_COMPLETION_TZ_V1.md`)
- **Статус:** `DONE` (аудит выполнен, только документация; реализация новых фич в рамках `R09.2` не запускалась)
- **Ветки и SHA:**
  - `alik7500-wq/tozon-backend` (`feat/crm-sales-completion`): `67c8702a5fe32f2435471d1a2a1c9a3d2b38a7b8` (до коммита документации `R09.2`)
  - `alik7500-wq/tozon-crm` (`a00`): `04c820da5a0dbf2c84f13443f71529a5baeea4a0`
- **Что сделано:**
  - Проведён построчный аудит `F-01–F-20`, `N-01–N-03` и `A01–A52` по фактическому коду и тестам в [R09_2_REQUIREMENTS_AUDIT.md](file:///d:/tozon-crm/server/docs/crm-sales/R09_2_REQUIREMENTS_AUDIT.md).
  - Разделены реализация (`IMPLEMENTED` / `PARTIAL` / `NOT_IMPLEMENTED`) и проверка (`PASS` / `FAIL` / `NOT_RUN` / `BLOCKED`).
  - Зарегистрированы 9 пробелов (`GAP-01`–`GAP-09`), включая `P0`-блокеры выпуска (`GAP-01` RoundRobinService, `GAP-05` UI проектных прав, `GAP-07` rollback `062`–`070`, `GAP-08` `TasksPage` `due_at`) и отсутствующий обработчик `F-20` (`GAP-02`).

## Следующая задача
- Закрытие `P0`-блокеров из [R09_2_REQUIREMENTS_AUDIT.md](file:///d:/tozon-crm/server/docs/crm-sales/R09_2_REQUIREMENTS_AUDIT.md) (`GAP-01`: `RoundRobinService` с проектным БД-курсором и воркером пула `unassigned`, `GAP-05`, `GAP-07`, `GAP-08`) перед общим прогоном `R09.3` и staging `R09.4`.
