# HANDOFF_R07.md — Автообновление без потери контекста, страниц, истории и черновиков

## Матрица приёмки R07
| Проверка | Реализация / файл | Среда | Статус |
|---|---|---|---|
| Сохранение нескольких загруженных страниц лидов и выход лида из фильтра после refresh | `LeadsPage.jsx` (`LeadsAutoRefreshR07.test.jsx`) | Vitest jsdom + fake timers | `PASS` |
| Независимая догрузка и обновление колонок доски (`boardColumns`) | `LeadsPage.jsx` (`LeadsWorkspaceCompletion.test.jsx`) | Vitest jsdom | `PASS` |
| Защита от поздних ответов `fetchLeads`/`fetchStats` при смене фильтра | `LeadsPage.jsx` (`LeadsAutoRefreshR07.test.jsx`) | Vitest jsdom + controlled promises | `PASS` |
| Восстановление `offline -> online` и отсутствие утечки таймеров на unmount | `LeadsPage.jsx` (`LeadsAutoRefreshR07.test.jsx`) | Vitest jsdom + fake timers | `PASS` |
| Выбранный диалог Instagram вне 1-й страницы не закрывается; новые сообщения не стирают старую историю | `InstagramInboxPage.jsx` (`InstagramAutoRefreshR07.test.jsx`) | Vitest jsdom + fake timers | `PASS` |
| Очистка `drafts` (как `Map`) и кэша на `403`, сохранение при `409`, отбрасывание позднего ответа после logout | `InstagramInboxPage.jsx` (`InstagramAutoRefreshR07.test.jsx`) | Vitest jsdom + controlled promises | `PASS` |
| Контекстная привязка `onSent` и сохранение черновика/состояния `unknown` | `InstagramReplyComposer.jsx` (`InstagramInterceptorR061.test.jsx`) | Real Axios interceptor + jsdom | `PASS` |
| Регрессионные тесты R05/R06 на backend | `instagram-r05-access.test.js`, `instagram-r06-send-idempotency.test.js`, `instagram-inbox-router.test.js`, `instagram-inbox.test.js` | PGlite + Supertest | `PASS` |
| Живые замеры производительности `N-02` и живая Meta API | — | Live staging / Meta | `NOT_RUN` |
