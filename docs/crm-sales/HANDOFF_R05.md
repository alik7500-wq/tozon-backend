# HANDOFF_R05.md — Доступ `SALES_MANAGER` к основной странице Instagram и серверным маршрутам

## Матрица приёмки R05
| Проверка | Реализация / файл | Среда / уровень | Статус |
|---|---|---|---|
| `SALES_MANAGER` открывает `InstagramInboxPage` через маршрут `/instagram/inbox` и меню | `navigationRegistry.js`, `MainLayout.jsx`, `InstagramInboxPage.jsx` (`InstagramManagerAccess.test.jsx`) | UI mocks (Vitest jsdom) | `PASS` |
| Открытие своего диалога и скрытие кнопок управления аккаунтами (`connection`/`connect`/`disconnect`) | `InstagramInboxPage.jsx` -> `GET /inbox/accounts` (`InstagramManagerAccess.test.jsx`) | UI mocks (Vitest jsdom) | `PASS` |
| Пустое состояние без доступных аккаунтов/диалогов и очистка кэша при отзыве | `InstagramInboxPage.jsx` (`InstagramManagerAccess.test.jsx`) | UI mocks (Vitest jsdom) | `PASS` |
| Свой разрешённый диалог (`accounts`, `conversations`, `page`, `messages`, `send`) через `protect` + `sectionAccess` + R04.2 | `sectionAccess.js`, `instagram-inbox.router.js` (`instagram-r05-access.test.js`) | Интеграционный HTTP-тест (PGlite + Supertest, мок Meta-клиента) | `PASS` |
| Запрет чужого диалога, запрещённого проекта, подмены `account`/`contact`/`cursor` и админ-маршрутов | `instagram-inbox.router.js`, `instagram.router.js` (`instagram-r05-access.test.js`) | Интеграционный HTTP-тест (PGlite + Supertest) | `PASS` |
| Разделение чтения/отправки по правам раздела (`leads.view` vs `leads.manage`) | `sectionAccess.js`, `instagram-inbox.router.js` (`instagram-r05-access.test.js`) | Интеграционный HTTP-тест (PGlite + Supertest) | `PASS` |
| Немедленный отзыв доступа в текущей сессии (переназначение лида, отзыв проекта, деактивация) | `protect` -> `UsersRepository` -> `instagram-inbox.router.js` (`instagram-r05-access.test.js`) | Интеграционный HTTP-тест (PGlite + Supertest) | `PASS` |
| Живая проверка с реальным Meta Graph API | `instagram-live.service.js` | Live Meta API (отсутствует тестовый токен) | `BLOCKED_MISSING_TOKEN` / `NOT_RUN` |

## Обязательное замечание для R09
- Вынести замену проектных прав (`UsersRepository.setProjectAccess`) в атомарную транзакцию PostgreSQL (RPC), чтобы исключить промежуточное состояние без прав при частичном сбое.
