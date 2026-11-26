# HANDOFF_R04.md — R04, R04.1 и R04.2: Фильтры, пагинация, доска, экспорт и реальный project scope

## Аудит источника проектных прав (R04.2)
- В существующей кодовой базе не было постоянного табличного или колоночного источника доступа пользователей к проектам (`user_cash_desk_access` существовал только для касс, а `layout_presentation.repository.js` проверял in-memory поле `user.assigned_project_ids`, которое не загружалось в `UsersRepository`).
- Реализована минимальная постоянная модель допуска в `src/db/migrations/066_user_project_access.sql`:
  - `public.users.all_projects_access BOOLEAN NOT NULL DEFAULT FALSE`
  - `public.user_project_access (id, user_id, project_id, can_view, created_by, created_at)` с `UNIQUE(user_id, project_id)`, RLS и `REVOKE ALL FROM PUBLIC, anon, authenticated`.

## Политика совместимости для существующих пользователей
- Миграция `066` **не** выдаёт автоматически `all_projects_access = TRUE` менеджерам или директорам и не изменяет рабочую базу.
- После применения `066` на staging/production администратор назначает допуски существующим пользователям явно через `PUT /api/users/:id/project-access` (либо контролируемым админ-скриптом).
- Исключение только для `ADMIN` с явным wildcard-правом `permissions: ['*']` (если `all_projects_access` не выставлен в `false`).

## Матрица приёмки R04.2
| Проверка | Реализация / путь | Среда | Статус |
|---|---|---|---|
| `SALES_MANAGER` видит только свои лиды в разрешённом проекте (`list`, `board`, `stats`, `export`) | `protect -> UsersRepository.findById -> user_project_access -> fn_query_leads_unified` (`066_project_access_integration.test.js`) | PGlite + Express/Supertest | `PASS` |
| `SALES_MANAGER` с пустым допуском получает `0` строк (fail-closed) | `leadFilterValidator` + `065` + `066` (`066_project_access_integration.test.js`) | PGlite + Express/Supertest | `PASS` |
| `DIRECTOR` с `all_projects_access = false` ограничен назначенным проектом | `leadFilterValidator` (без автовывода глобальных прав) + `066_project_access_integration.test.js` | PGlite + Express/Supertest | `PASS` |
| `ADMIN` с явным `all_projects_access = true` видит все проекты | `066_project_access_integration.test.js` | PGlite + Express/Supertest | `PASS` |
| Ошибка загрузки `user_project_access` возвращает `503` (не `200 []` и не расширение прав) | `UsersRepository.findById` -> `protect` -> Express errorHandler (`066_project_access_integration.test.js`) | PGlite + Express/Supertest | `PASS` |
| Проверка на live staging PostgreSQL | — | Live staging Supabase | `NOT_RUN` |
