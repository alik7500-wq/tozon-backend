# CURRENT_TASK.md

- **ID задачи:** `R05` — Доступ `SALES_MANAGER` к основной странице Instagram и серверным маршрутам
- **Статус:** `DONE` (UI mocks + PGlite HTTP `protect/sectionAccess/R04.2` тесты пройдены; живая проверка Meta — `BLOCKED_MISSING_TOKEN` / `NOT_RUN` из-за отсутствия тестового токена Meta в среде)
- **Ветки:**
  - `tozon-backend`: `feat/crm-sales-completion`
  - `tozon-crm`: `a00`
- **Что сделано:**
  - Frontend (`navigationRegistry.js`, `MainLayout.jsx`, `InstagramInboxPage.jsx`):
    - Открыт пункт меню `Instagram Direct` (`/instagram/inbox`) для `SALES_MANAGER` с правом `leads.view`.
    - `InstagramInboxPage` разделён на режим управления (`ADMIN`/`DIRECTOR` -> `/integrations/instagram/connection`, кнопки подключения/отключения) и режим менеджера (`SALES_MANAGER` -> безопасный `GET /integrations/instagram/inbox/accounts`, без кнопок управления и OAuth-настроек, с пустым состоянием при отсутствии допусков).
    - При отзыве доступа, смене аккаунта/пользователя или исчезновении диалога из списка `historyCache` и `drafts` очищаются.
  - Backend (`sectionAccess.js`, `instagram-inbox.router.js`):
    - `sectionAccess.js` допускает `SALES_MANAGER` к `GET /inbox/accounts`, `GET /inbox/conversations`, `GET /inbox/conversations/page`, `GET /inbox/conversations/:account/:contact/messages` и `POST /send/:account/:contact` по правам `leads.view` / `leads.manage`; административные маршруты `/connection`, `/connect`, `/disconnect` остаются строго за `ADMIN`/`DIRECTOR`.
    - `instagram-inbox.router.js` проверяет реальные проектные права R04.2 (`all_projects_access`, `allowed_project_ids`) + `responsible_user_id` + права раздела (`leads.view`/`leads.manage`) на всех операциях (список, пагинация, сообщения, отправка) и отклоняет подмену `account`/`contact`/`cursor` и запросы после отзыва доступа.

## Обязательный список R09 (зарегистрировано в R05)
- **Транзакционная замена проектных прав (`UsersRepository.setProjectAccess`):** перенести обновление `users.all_projects_access`, удаление старых и вставку новых строк `user_project_access` в единую атомарную SQL-транзакцию (RPC), чтобы сбой в середине не оставлял пользователя без проектных прав.

## Следующая задача
- `R06` — Оставшиеся задачи этапа R06 (в ветках `feat/crm-sales-completion` и `a00`).
