# CURRENT_TASK.md

- **ID задачи:** `GAP-05` — Интерфейс управления проектными правами пользователей
- **Статус:** `DONE` (client `vite build` `PASS`, client Vitest 2 файла 15/15 `PASS`, server PGlite 3 файла 13/13 `PASS`; сквозной browser E2E на staging — `NOT_RUN`)
- **Ветки:**
  - `alik7500-wq/tozon-crm`: `a00`
  - `alik7500-wq/tozon-backend`: `feat/crm-sales-completion`
- **Что сделано:**
  - Frontend (`a00`): добавлен `ProjectAccessModal.jsx` и кнопка «Проекты» в `UsersPage.jsx` (только для `ADMIN`): загрузка текущих прав (`GET /api/users/:id` + `GET /api/projects`), переключатель `all_projects_access` («Все проекты»), чекбоксы конкретных проектов, явное состояние «Нет доступа к проектам», блокировка повторного сохранения, сохранение редактируемых значений при ошибке, защита от позднего ответа при смене пользователя, отображение ошибки загрузки без подмены пустым списком.
  - Тесты: `UsersProjectAccess.test.jsx` (4/4 `PASS`), `075_gap05_project_access_api.test.js` (2/2 `PASS` — запрет `DIRECTOR`/`SALES_MANAGER`, отсутствие автопереназначения лидов и немедленный отзыв доступа в открытой сессии).
  - Добавлена инструкция администратору по назначению допусков существующим сотрудникам в `HANDOFF_R09.md`.

## Следующая задача
- Закрытие оставшихся `P0`-блокеров из [R09_2_REQUIREMENTS_AUDIT.md](file:///d:/tozon-crm/server/docs/crm-sales/R09_2_REQUIREMENTS_AUDIT.md): `GAP-07` (rollback `062`–`074`) и `GAP-08` (`TasksPage` `due_at`).
