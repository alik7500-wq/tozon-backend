# HANDOFF_R07.md — R07 & R07.1: Автообновление больших списков, догрузка колонок и очистка при отзыве доступа

## Дополнения R07.1
- **Без непроверенного хвоста (`LeadsPage.jsx`):**
  - При загруженном списке `>500` лидов фоновое обновление постранично догружает актуальные страницы (`limit: 500`, `cursor`) до полного покрытия загруженного диапазона.
  - При загруженной колонке `>100` карточек фоновое обновление догружает хвост колонки через `/leads?stage=...&cursor=...&limit=100`, исключая дубликаты при переносе между колонками и удаляя архивированные/отозванные записи.
- **Защита `handleLoadMoreColumn` и синхронизация `leads` / `boardColumns`:**
  - Запрос догрузки колонки привязан к `leadsContextRef`, `columnRequestRef[stageKey]` и `boardGenerationRef`; поздние ответы отбрасываются при смене проекта/фильтра или конфликте с `refresh`.
  - Плоский `leads` выводится из финально объединённых `boardColumns` через `flattenBoardColumns`.
- **Очистка `sessionStorage` и защита от поздних ответов (`InstagramInboxPage.jsx`, `InstagramReplyComposer.jsx`):**
  - При `401`/`403` удаляются записи в UI, `historyCache`, `drafts` (`Map`) и `sessionStorage`; поздние ответы `submit`/`reconcile` после отзыва/размонтирования/смены пользователя отбрасываются.

## Итоги проверок
- **Client (`Vitest jsdom`):** 12 файлов, **51/51 тест `PASS`** (включая `LeadsAutoRefreshR07.test.jsx` 5/5 и `InstagramAutoRefreshR07.test.jsx` 2/2); `vite build` `PASS`.
- **Server (`PGlite` + `Supertest`):** 4 файла, **29/29 тестов `PASS`** (R05/R06 регрессия).
- **Live `N-02` / staging / Meta:** `NOT_RUN`.
