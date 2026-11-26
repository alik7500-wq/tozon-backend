# CURRENT_TASK.md

- **ID задачи:** `R04.2` — Подключение реального источника проектных прав
- **Статус:** `DONE` (PGlite HTTP end-to-end `protect -> UsersRepository -> user_project_access -> queryUnified -> fn_query_leads_unified` + все модульные тесты пройдены; сохранение догруженных страниц при автообновлении передано в `R07`; live staging — `NOT_RUN`)
- **Ветки:**
  - `tozon-backend`: `feat/crm-sales-completion`
  - `tozon-crm`: `a00` (без изменений в `R04.2`)
- **Что сделано:**
  - Зафиксировано отсутствие ранее существовавшего постоянного источника проектных прав в БД (`layout_presentation.repository.js` проверял только in-memory `assigned_project_ids`).
  - Создана миграция `066_user_project_access.sql`: колонка `users.all_projects_access BOOLEAN NOT NULL DEFAULT FALSE` и таблица `public.user_project_access(user_id, project_id, can_view)` с RLS и правами только для `service_role`.
  - В `UsersRepository.findById` подключена загрузка `all_projects_access` и `allowed_project_ids` из `public.user_project_access`; ошибка чтения `user_project_access` явно возвращает `503 AppError` (без расширения прав и без маскировки под пустой список).
  - В `users.router.js` добавлен `PUT /api/users/:id/project-access` (только `ADMIN`) для явного назначения допусков существующим и новым пользователям без автоматической модификации рабочей БД.
  - В `leadFilterValidator.js` убран автоматический вывод глобальных прав `DIRECTOR` из отсутствия `allowed_project_ids`: `DIRECTOR` без `all_projects_access = true` строго ограничен назначенными проектами (или видит `0` строк при пустом списке).
  - Добавлен полный HTTP-интеграционный тест `066_project_access_integration.test.js` (`protect` + JWT + `UsersRepository.findById` + `user_project_access` + `leadsRouter` + `fn_query_leads_unified` в PGlite).

## Передано в R07
- Сохранение догруженных по `nextCursor` страниц при фоновом периодическом автообновлении — решается в `R07`.

## Следующая задача
- `R05` — Доступ `SALES_MANAGER` к основной `InstagramInboxPage` и маршруту (в ветках `feat/crm-sales-completion` и `a00`).
