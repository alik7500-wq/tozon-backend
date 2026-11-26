# R09.2 — Аудит полноты реализации `TOZON_CRM_SALES_COMPLETION_TZ_V1.md`

**Дата аудита:** 2026-11-27  
**Источник требований:** `TOZON_CRM_SALES_COMPLETION_TZ_V1.md` (версия 1.0 от 22.11.2026)  
**Проверенные репозитории и полные SHA:**
- `alik7500-wq/tozon-backend` (`feat/crm-sales-completion`): `67c8702a5fe32f2435471d1a2a1c9a3d2b38a7b8`
- `alik7500-wq/tozon-crm` (`a00`): `04c820da5a0dbf2c84f13443f71529a5baeea4a0`

> **Правило классификации:**
> - **Реализация:** `IMPLEMENTED` / `PARTIAL` / `NOT_IMPLEMENTED`
> - **Проверка:** `PASS` / `FAIL` / `NOT_RUN` / `BLOCKED`
> - Наличие файла, unit-теста или PGlite/mock-теста **не приравнивается** к сквозной готовности на staging/production. Отсутствующий обработчик не маскируется под `BLOCKED_MISSING_KEY`.

---

## 1. Сводка аудита

### По требованиям F-01–F-20 и N-01–N-03 (23 пункта)
- **IMPLEMENTED:** **15** (`F-01`, `F-02`, `F-03`, `F-04`, `F-05`, `F-06`, `F-08`, `F-09`, `F-10`, `F-11`, `F-12`, `F-14`, `F-15`, `N-01`, `N-03`)
- **PARTIAL:** **7** (`F-07`, `F-13`, `F-16`, `F-17`, `F-18`, `F-19`, `F-20`)
- **NOT_IMPLEMENTED:** **1** (`N-02` — стенд/методика нагрузочного замера не реализованы)
- **Проверки (F/N):**
  - `PASS` (в unit / PGlite / jsdom mock): **15** (`F-01`, `F-02`, `F-03`, `F-04`, `F-05`, `F-06`, `F-08`, `F-09`, `F-12`, `F-14`, `F-15`, `N-01`, `N-03`, частично `F-11`, `F-13`) — при этом сквозная live-проверка на реальном PostgreSQL/PostgREST для всех перечисленных остаётся `NOT_RUN`.
  - `NOT_RUN`: **5** (`F-07`, `F-10`, `F-16`–`F-18`, `F-19`)
  - `BLOCKED`: **3** (`F-11` live Meta, `F-20` live OpenAI/аудио + отсутствует worker, `N-02` staging/нагрузка)

### По сценариям приёмки A01–A52 (52 сценария)
- `IMPLEMENTED`: **43**
- `PARTIAL`: **7** (`A09`, `A19`, `A39`, `A47`, `A49`, `A50`, `A51`)
- `NOT_IMPLEMENTED`: **2** (`A49` реальный ИИ-воркер аудио, `A52` нагрузочный раннер `N-02`)
- **Проверки (A01–A52):**
  - `PASS` (только unit / PGlite / jsdom mock): **30** (`A01`, `A03`, `A04`, `A05`, `A08`, `A10` PGlite, `A11`, `A12`, `A13`, `A14`, `A16`, `A17`, `A18`, `A23`, `A24`, `A25`, `A26`, `A27`, `A30`, `A31`, `A32`, `A33`, `A34`, `A35`, `A36`, `A37`, `A38`, `A42`, `A45`, `A46`)
  - `NOT_RUN` (требуют staging PostgreSQL / 2-process / browser E2E): **18**
  - `BLOCKED` (требуют внешние доступы / live Meta / OpenAI + доработку worker): **4** (`A02`, `A48`, `A49`, `A52`)

---

## 2. Матрица требований F-01–F-20 и N-01–N-03

| ID | Требование | Backend | Frontend | Тест | Среда проверки | Реализация | Проверка | Пробел / Дефект |
|---|---|---|---|---|---|---|---|---|
| F-01 | Каноническая воронка (9 этапов, единый источник истины) | `leadDomain.js`, `leads.router.js` (`/stages`), `062`/`063` | `LeadKanbanView.jsx`, `LeadsPage.jsx` | `leadDomain.test.js`, `LeadsWorkspaceCompletion.test.jsx` | Unit + jsdom | `IMPLEMENTED` | `PASS` (unit/mock); `NOT_RUN` (live) | Требуется E2E на staging PostgreSQL |
| F-02 | Правила переходов этапов, причины отказа, откат с причиной | `leadDomain.js`, `062_atomic_lead_stage_transition.sql`, `063` | `LeadDrawer.jsx`, `LeadKanbanView.jsx` | `062_atomic_stage_transition.test.js` (7/7), `leadDomain.test.js` | PGlite + Unit | `IMPLEMENTED` | `PASS` (PGlite); `NOT_RUN` (live) | Нет rollback-скрипта для `062`/`063` (`GAP-07`) |
| F-03 | Общие фильтры, доска/таблица/список, курсор, счётчики, экспорт | `064`/`065`, `leadFilterValidator.js`, `leads.router.js` (`/`, `/export`, `/stats`) | `LeadsPage.jsx` (3 вида, URL, порционная доска) | `064_unified_query_cursor.test.js`, `066_project_access_integration.test.js` (5/5) | PGlite + jsdom | `IMPLEMENTED` | `PASS` (PGlite/mock); `NOT_RUN` (browser E2E) | Нет UI для назначения `project-access` существующим пользователям (`GAP-05`) |
| F-04 | Карточка на доске (контакт, ID, проект, бюджет/«Не указан», узкий экран) | `leads.repository.js` | `LeadKanbanView.jsx` | `LeadsWorkspaceCompletion.test.jsx` | jsdom + `vite build` | `IMPLEMENTED` | `PASS` (jsdom/build) | — |
| F-05 | Единый жизненный цикл входящего события (outbox, SQL-пути) | `060`, `068`, `069`, `070`, `OutboxWorkerService` | — | `068_outbox_worker.test.js` (8/8), `070` (6/6), `071` (5/5) | PGlite | `IMPLEMENTED` | `PASS` (PGlite); `NOT_RUN` (2-proc PG) | Не проверен на 2 независимых процессах реального PostgreSQL |
| F-06 | Источники, UTM, Google Forms/Sheets, файловый импорт, исторический импорт | `lead-intake/` (`intake.router.js`, `intake.service.js`), `060`, `070` | `LeadIntakeModal.jsx` | `intake.migration.test.js`, `LeadIntakeModal.test.jsx`, `070` | PGlite + jsdom | `IMPLEMENTED` | `PASS` (PGlite/jsdom) | Требуется staging-проверка live Google Forms/импорта большой партии |
| F-07 | Повторы, дедупликация контактов и ручное объединение дублей | `060` (`contacts`, `uq_contacts_instagram_identity`), `intake.service.js` | `ClientsPage.jsx` | `060_crm_sales_completion_foundation.test.js` | PGlite | `PARTIAL` | `NOT_RUN` (merge UI) | Отсутствует UI поиска и предпросмотра объединения дублей контактов (`GAP-04`) |
| F-08 | Проектные правила распределения, очередь без назначения, постоянный курсор | `071` (`fn_select_and_assign_lead_atomic`, `fn_run_lead_pool_batch`), `roundRobin.service.js`, `leadPoolWorker.service.js`, `run-lead-pool-worker.js` | `SalesControlPanel.jsx` | `071_r09_2_gap01_distribution.test.js` (5/5) | PGlite | `IMPLEMENTED` | `PASS` (PGlite); `NOT_RUN` (2-proc PG) | Требуется 2-процессный прогон `verify-gap01-two-process-pg.mjs` на staging PostgreSQL |
| F-09 | Конкурентная безопасность назначения (409 CAS) и журнал | `060`/`061` (`fn_assign_lead_atomic`), `leads.router.js` | `LeadDrawer.jsx`, `LeadControlView.jsx` | `060_pre_release_isolation.test.js` | PGlite | `IMPLEMENTED` | `PASS` (PGlite); `NOT_RUN` (2-proc PG) | Автораспределение `RoundRobinService` не использует DB-lock/DB-cursor (`GAP-01`) |
| F-10 | Единая карточка лида (лента, переписки, задачи, объекты, «Оформить сделку») | `leads.router.js`, `leads.repository.js` | `LeadDrawer.jsx` | `vite build` | Build | `IMPLEMENTED` | `NOT_RUN` (browser E2E) | Не пройден полный браузерный E2E сценарий |
| F-11 | Instagram: права менеджера, вложения, отправка, идемпотентность, UNKNOWN, сверка | `instagram-inbox.router.js`, `067_instagram_send_idempotency.sql` | `InstagramInboxPage.jsx`, `InstagramReplyComposer.jsx`, `InstagramAccounts.jsx` | `Instagram*.test.jsx` (jsdom), R05/R06 server tests | jsdom + unit | `IMPLEMENTED` | `PASS` (jsdom/unit); `BLOCKED` (live Meta) | Заблокирована сквозная проверка на live Meta API (нужен тестовый токен и профиль) |
| F-12 | Контакты и звонки (разделение попытки, недозвона и разговора; ручная/авто) | `leadDomain.js`, `leads.repository.js`, `calls.router.js` | `LeadDrawer.jsx` | `leadDomain.test.js`, `070` | Unit + PGlite | `IMPLEMENTED` | `PASS` (unit/PGlite); `NOT_RUN` (live Moizvonki) | Требуется проверка callback Moizvonki на staging |
| F-13 | Точные сроки `due_at`, задачи, первичная задача, отмена при отказе | `060`, `062`, `063`, `tasks.service.js`, `OutboxWorkerService` | `LeadDrawer.jsx`, `TasksPage` | `060`, `062`, `063`, `068`, `070` | PGlite | `PARTIAL` | `PASS` (PGlite backend); `NOT_RUN` (TasksPage UI) | На `TasksPage` не подтверждён/не протестирован ввод точного времени `due_at` (`GAP-08`) |
| F-14 | SLA (Asia/Dushanbe), паузы, эскалация без дублей | `leadSla.service.js`, `businessTime.js`, `OutboxWorkerService` | `LeadControlView.jsx` | `LeadControlView.test.jsx`, `070` | jsdom + PGlite | `IMPLEMENTED` | `PASS` (jsdom/PGlite); `NOT_RUN` (live) | — |
| F-15 | Единый критерий покупателя (только `SIGNED`, защита от дублей/расторжения) | `060`, `deals`, `leadDomain.js` | `ClientsPage.jsx`, Deal Wizard | `ClientsPage.buyers.test.jsx`, `DealWizardBuyerEligibility.test.jsx` | jsdom + PGlite | `IMPLEMENTED` | `PASS` (jsdom/PGlite) | — |
| F-16 | Аналитика: 4 обязательных режима (состояние, события, когорта, план-факт) | `salesAnalytics.service.js`, `managerPerformance.service.js`, `blockPlanFact.service.js` | `SalesAnalyticsPage.jsx`, `SalesManagementDashboard.jsx`, `ManagerPerformanceView.jsx` | `SalesAnalyticsPage.test.jsx`, `SalesManagementDashboard.test.jsx` | jsdom + unit | `PARTIAL` | `NOT_RUN` (live БД сверка) | Когортная воронка и план-факт не сведены в единую сквозную проверку на реальной БД (`GAP-06`) |
| F-17 | Точные формулы аналитики (медиана/P90/P95 первого ответа, когорты, без фиктивных нулей) | `managerPerformance.service.js`, `salesAnalytics.service.js` | `SalesAnalyticsPage.jsx` | `sales_automation_v1_2.test.js` | Unit | `PARTIAL` | `FAIL` (аудит кода) | В `salesAnalytics.service.js` и `managerPerformance.service.js` отсутствуют расчёты **медианы, P90 и P95** времени первого ответа и поэтапная когортная конверсия (`GAP-06`) |
| F-18 | Отнесение результата и детализация / Excel | `managerPerformance.service.js`, `salesManagementExport.service.js` | `ManagerPerformanceView.jsx` | `sales_automation_v1_2.test.js` | Unit | `PARTIAL` | `NOT_RUN` (live сверка) | Не подтверждена сквозная сходимость клика на KPI-цифру с фильтрами списка и Excel на live БД (`GAP-06`) |
| F-19 | Управление правилами автоматизации (UI + API + preview + выполнение + журнал) | `060`, `automation.router.js` (`/crm-rules`), `OutboxWorkerService` | **Отсутствует** | `068_outbox_worker.test.js` (execution) | PGlite (только backend) | `PARTIAL` | `NOT_RUN` (UI + preview) | Нет UI-экрана `/crm-rules` в `client/src`; `POST /crm-rules/:id/preview` не учитывает `conditions_json` и `source_code` (`GAP-03`) |
| F-20 | Проверяемый анализ звонков ИИ (очередь, аудио, провайдер, ошибки, подтверждение) | `060` (`call_ai_analyses`), `calls.router.js` | `LeadDrawer.jsx` (вкладка «ИИ-звонки») | — | Build / static audit | `PARTIAL` | `FAIL` (нет worker) / `BLOCKED` (нет ключа/выборки) | Отсутствует фоновый worker обработки `QUEUED` записей, загрузка аудио Moizvonki и вызов OpenAI (`GAP-02`) |
| N-01 | Автообновление интерфейса (список, доска, Instagram) без потери контекста/черновика | `leads.router.js` (`/updates`), `instagram-inbox.router.js` | `LeadsPage.jsx`, `InstagramInboxPage.jsx`, `InstagramReplyComposer.jsx` | `InstagramInboxPage.test.jsx`, R07/R07.1 tests | jsdom + unit | `IMPLEMENTED` | `PASS` (jsdom); `NOT_RUN` (live polling) | Требуется browser E2E на live API |
| N-02 | Целевые SLA P95 (≤1.5с / ≤3с / ≤7с) при 2x нагрузке, 2 backend + 10 сессий | — | — | — | Отсутствует staging-стенд | `NOT_IMPLEMENTED` | `BLOCKED` / `NOT_RUN` | Нет нагрузочного стенда, скрипта замеров P95 и прогона на staging (`GAP-09`) |
| N-03 | Надёжность, outbox, карантин, централизованный gate, наблюдаемость | `068`, `069`, `070`, `OutboxWorkerService`, `outbox.router.js`, `run-outbox-worker.js` | — | `068` (8/8), `070` (6/6), `071` (5/5) | PGlite + Express | `IMPLEMENTED` | `PASS` (PGlite); `NOT_RUN` (2-proc PG) | Требуется 2-процессный прогон на реальном PostgreSQL |

---

## 3. Матрица приёмки A01–A52

| ID | Приоритет | Требование | Backend | Frontend | Тест | Среда проверки | Реализация | Проверка | Пробел / Дефект |
|---|---|---|---|---|---|---|---|---|---|
| A01 | P0 | Ручной новый лид | `leads.router.js`, `OutboxWorkerService` | `LeadIntakeModal.jsx` | `070`, `LeadIntakeModal.test.jsx` | PGlite + jsdom | `IMPLEMENTED` | `PASS` (mock/PGlite); `NOT_RUN` (live) | Нужен E2E на staging |
| A02 | P0 | Новое входящее Instagram (не обходится SQL-путём) | `instagram-inbox.router.js`, `060` | `InstagramInboxPage.jsx` | — | Live Meta | `IMPLEMENTED` | `BLOCKED` | Нужен тестовый Meta webhook/токен |
| A03 | P0 | Повтор одного webhook | `060` (`crm_event_outbox`), `intake.service.js` | — | `060_pre_release_isolation.test.js` | PGlite | `IMPLEMENTED` | `PASS` (PGlite); `NOT_RUN` (live) | — |
| A04 | P0 | Два разных сообщения в диалоге | `instagram-inbox.router.js` | `InstagramInboxPage.jsx` | `InstagramInboxPage.test.jsx` | jsdom | `IMPLEMENTED` | `PASS` (mock); `NOT_RUN` (live) | — |
| A05 | P0 | Исходящее эхо и импорт старой истории | `OutboxWorkerService`, `070` | — | `070_r09_1_consistency.test.js` | PGlite | `IMPLEMENTED` | `PASS` (PGlite); `NOT_RUN` (live) | — |
| A06 | P0 | Один контакт в другом проекте | `060` (`contacts`), `intake.service.js` | `LeadDrawer.jsx` | — | — | `IMPLEMENTED` | `NOT_RUN` | Нужен API/E2E тест |
| A07 | P0 | Одинаковое имя, разные контакты | `060` (`uq_contacts_instagram_identity`) | — | — | — | `IMPLEMENTED` | `NOT_RUN` | Нужен API тест |
| A08 | P0 | Нет номера телефона | `060` (`leads.phone NULL`) | `LeadKanbanView.jsx` | `060_crm_sales_completion_foundation.test.js` | PGlite | `IMPLEMENTED` | `PASS` (PGlite) | — |
| A09 | P0 | Повтор импорта/возобновление партии | `intake.service.js`, `intake.files.js` | `LeadIntakeModal.jsx` | `intake.migration.test.js` | PGlite | `PARTIAL` | `PASS` (unit/PGlite); `NOT_RUN` (live) | Проверить возобновление прерванной партии на staging |
| A10 | P0 | Два процесса принимают события одновременно | `068` (`fn_claim_outbox_batch`), `071` (`fn_select_and_assign_lead_atomic`) | — | `068`, `071_r09_2_gap01_distribution.test.js` | PGlite | `IMPLEMENTED` | `PASS` (PGlite); `NOT_RUN` (2-proc PG) | Требуется прогон `verify-gap01-two-process-pg.mjs` на реальном PostgreSQL |
| A11 | P0 | Ручное и автоназначение одновременно (409) | `061` (`fn_assign_lead_atomic`), `071` | `LeadControlView.jsx` | `060_pre_release_isolation.test.js`, `071_r09_2_gap01_distribution.test.js` | PGlite | `IMPLEMENTED` | `PASS` (PGlite); `NOT_RUN` (2-proc) | — |
| A12 | P0 | Менеджер вне проекта/уволен/исключён | `071` (`fn_select_and_assign_lead_atomic`), `roundRobin.service.js` | — | `071_r09_2_gap01_distribution.test.js` | PGlite | `IMPLEMENTED` | `PASS` (PGlite); `NOT_RUN` (staging) | — |
| A13 | P0 | Нет доступного менеджера/сбой настроек | `071`, `roundRobin.service.js`, `outboxWorker.service.js` | — | `071_r09_2_gap01_distribution.test.js`, `071_r09_1_1` | PGlite | `IMPLEMENTED` | `PASS` (PGlite); `NOT_RUN` (staging) | — |
| A14 | P0 | Перезапуск распределителя | `071` (`lead_distribution_settings.round_robin_cursor`) | — | `071_r09_2_gap01_distribution.test.js` | PGlite | `IMPLEMENTED` | `PASS` (PGlite); `NOT_RUN` (staging) | — |
| A15 | P0 | Повторное назначение/снятие, журнал, перенос задач | `061`, `070` (`RECIPIENT_STALE_REASSIGNED`) | `LeadDrawer.jsx` | `070` (гонка) | PGlite | `IMPLEMENTED` | `NOT_RUN` (полный E2E) | Проверить перенос открытых задач при смене менеджера в E2E |
| A16 | P0 | Перемещение NEW не создаёт первый ответ | `062`, `leadDomain.js` | `LeadKanbanView.jsx` | `062_atomic_stage_transition.test.js` | PGlite | `IMPLEMENTED` | `PASS` (PGlite) | — |
| A17 | P0 | Повторная фиксация контакта не стирает первый | `leads.repository.js` (`recordFirstContact`) | `LeadDrawer.jsx` | `leadDomain.test.js` | Unit | `IMPLEMENTED` | `PASS` (unit); `NOT_RUN` (live) | — |
| A18 | P0 | «Не ответил» и успешный разговор | `leadDomain.js`, `OutboxWorkerService` | `LeadDrawer.jsx` | `leadDomain.test.js`, `070` | Unit + PGlite | `IMPLEMENTED` | `PASS` (unit/PGlite) | — |
| A19 | P0 | Срок задачи внутри дня, точная просрочка | `060` (`due_at`), `leadSla.service.js` | `LeadDrawer.jsx`, `TasksPage` | `060`, `070` | PGlite | `PARTIAL` | `NOT_RUN` (UI TasksPage) | Проверить UI ввода времени на `TasksPage` (`GAP-08`) |
| A20 | P0 | Ночь, граница дня, рабочий календарь | `businessTime.js`, `leadSla.service.js` | — | `leadSla.test.js` | Unit | `IMPLEMENTED` | `NOT_RUN` (staging TZ check) | — |
| A21 | P0 | Смена ответственного не обнуляет общую задержку | `leadSla.service.js`, `070` | `LeadControlView.jsx` | `070` | PGlite | `IMPLEMENTED` | `NOT_RUN` (live) | — |
| A22 | P0 | Встреча/показ назначены, но не состоялись | `062`, `leadDomain.js` | `LeadDrawer.jsx` | `062` | PGlite | `IMPLEMENTED` | `NOT_RUN` (live отчёт) | — |
| A23 | P0 | Отказ без причины / «Другое» без комментария | `062`, `leadDomain.js` | `LeadKanbanView.jsx` | `062_atomic_stage_transition.test.js` | PGlite | `IMPLEMENTED` | `PASS` (PGlite) | — |
| A24 | P0 | Лид/бронь/черновик/старый WON без SIGNED вне клиентов | `060`, `leadDomain.js`, `deals` | `ClientsPage.jsx` | `060`, `ClientsPage.buyers.test.jsx` | PGlite + jsdom | `IMPLEMENTED` | `PASS` (PGlite/jsdom) | — |
| A25 | P0 | Подписанный договор и повтор подписания | `deals` | `ClientsPage.jsx`, Deal Wizard | `DealWizardBuyerEligibility.test.jsx` | jsdom | `IMPLEMENTED` | `PASS` (jsdom); `NOT_RUN` (live) | — |
| A26 | P0 | Два договора одного покупателя | `deals`, `contacts` | `ClientsPage.jsx` | `ClientsPage.buyers.test.jsx` | jsdom | `IMPLEMENTED` | `PASS` (jsdom); `NOT_RUN` (live) | — |
| A27 | P0 | Расторжение и другой действующий договор | `deals` | `ClientsPage.jsx` | `ClientsPage.buyers.test.jsx` | jsdom | `IMPLEMENTED` | `PASS` (jsdom); `NOT_RUN` (live) | — |
| A28 | P0 | Прямая попытка открыть чужой lead/dialog/media | `leads.router.js`, `instagram-inbox.router.js`, `066` | — | `066`, R05 tests | PGlite + unit | `IMPLEMENTED` | `PASS` (PGlite/unit); `NOT_RUN` (live) | — |
| A29 | P0 | Изменение роли/проекта во время сессии | `users.repository.js`, `070`, `InstagramInboxPage.jsx` | `LeadsPage.jsx`, `InstagramInboxPage.jsx` | `070`, R07.1 jsdom tests | PGlite + jsdom | `IMPLEMENTED` | `PASS` (mock); `NOT_RUN` (live) | Нет UI назначения `project-access` (`GAP-05`) |
| A30 | P0 | Два Instagram-профиля с одинаковым внешним ID | `060`, `instagram-inbox.router.js` | `InstagramInboxPage.jsx`, `InstagramReplyComposer.jsx` | `Instagram*.test.jsx` | jsdom | `IMPLEMENTED` | `PASS` (jsdom); `NOT_RUN` (live) | — |
| A31 | P0 | Двойной клик «Отправить» | `067_instagram_send_idempotency.sql` | `InstagramReplyComposer.jsx` | R06 tests | jsdom + unit | `IMPLEMENTED` | `PASS` (mock); `NOT_RUN` (live Meta) | — |
| A32 | P0 | Meta приняла, БД не сохранила / сеть оборвалась | `067`, `instagram-inbox.router.js` | `InstagramReplyComposer.jsx` | R06.1 tests | jsdom + unit | `IMPLEMENTED` | `PASS` (mock); `NOT_RUN` (live Meta) | — |
| A33 | P0 | Запрет API / окно ответа / истёкший токен | `instagram-inbox.router.js` | `InstagramReplyComposer.jsx` | R06.1 tests | jsdom + unit | `IMPLEMENTED` | `PASS` (mock); `NOT_RUN` (live Meta) | — |
| A34 | P1 | Фильтр проекта/менеджера/источника на всех видах + экспорт | `064`/`065`, `leads.router.js` | `LeadsPage.jsx` | `064`, `066`, `LeadsWorkspaceCompletion.test.jsx` | PGlite + jsdom | `IMPLEMENTED` | `PASS` (PGlite/jsdom); `NOT_RUN` (live) | — |
| A35 | P1 | Переключение вида/карточки/возврат сохраняет контекст | — | `LeadsPage.jsx` | `LeadsWorkspaceCompletion.test.jsx` | jsdom | `IMPLEMENTED` | `PASS` (jsdom); `NOT_RUN` (browser) | — |
| A36 | P1 | Пагинация (>500 / >100) и новые события | `064`/`065` | `LeadsPage.jsx` | `064`, R07.1 jsdom tests | PGlite + jsdom | `IMPLEMENTED` | `PASS` (PGlite/jsdom); `NOT_RUN` (live) | — |
| A37 | P1 | Автообновление без потери черновика/прокрутки | `leads.router.js` (`/updates`) | `LeadsPage.jsx`, `InstagramInboxPage.jsx` | `InstagramInboxPage.test.jsx`, R07 | jsdom | `IMPLEMENTED` | `PASS` (jsdom); `NOT_RUN` (browser) | — |
| A38 | P1 | Поздний ответ старого фильтра/аккаунта | — | `LeadsPage.jsx`, `InstagramInboxPage.jsx` | R07.1 jsdom tests | jsdom | `IMPLEMENTED` | `PASS` (jsdom) | — |
| A39 | P1 | Автозадача и служебная заметка не считаются обработкой | `leadDomain.js`, `managerPerformance.service.js` | — | — | Static audit | `PARTIAL` | `NOT_RUN` | Сверить все ветки `salesAnalytics.service.js` (`GAP-06`) |
| A40 | P1 | Один лид, несколько договоров (когорта ≤ 100%) | `managerPerformance.service.js` | `ManagerPerformanceView.jsx` | `sales_automation_v1_2.test.js` | Unit | `IMPLEMENTED` | `NOT_RUN` (live БД) | — |
| A41 | P1 | Новый менеджер после продажи не меняет исторического продавца | `deals`, `managerPerformance.service.js` | `ManagerPerformanceView.jsx` | — | — | `IMPLEMENTED` | `NOT_RUN` | Нужен интеграционный тест |
| A42 | P1 | Нет плана/знаменателя/истории -> «Не задан / Нет базы» | `managerPerformance.service.js` | `ManagerPerformanceView.jsx`, `SalesAnalyticsPage.jsx` | `sales_automation_v1_2.test.js` | Unit | `IMPLEMENTED` | `PASS` (unit); `NOT_RUN` (live) | — |
| A43 | P1 | Клик на KPI и экспорт Excel совпадают | `salesManagementExport.service.js` | `ManagerPerformanceView.jsx` | — | — | `IMPLEMENTED` | `NOT_RUN` | Нужна сверка на реальных данных (`GAP-06`) |
| A44 | P1 | Повторный цикл эскалации без дублей уведомлений | `OutboxWorkerService`, `069` | — | `068_outbox_worker.test.js` | PGlite | `IMPLEMENTED` | `NOT_RUN` (cron эскалации) | — |
| A45 | P1 | Сбой после создания лида до задачи | `OutboxWorkerService`, `068`, `069` | — | `068_outbox_worker.test.js` | PGlite | `IMPLEMENTED` | `PASS` (PGlite); `NOT_RUN` (2-proc PG) | — |
| A46 | P1 | Остановка/возобновление фонового обработчика и единый gate | `OutboxWorkerService`, `outbox.router.js`, `run-outbox-worker.js` | — | `071_r09_1_1_outbox_gate.test.js` (5/5) | PGlite + Node | `IMPLEMENTED` | `PASS` (PGlite); `NOT_RUN` (staging) | — |
| A47 | P2 | Предпросмотр и включение правила автоматизации | `automation.router.js`, `OutboxWorkerService` | **Отсутствует** | `068` (без UI и фильтрации preview) | PGlite | `PARTIAL` | `NOT_RUN` (UI + preview) | Нет UI `/crm-rules`; `preview` игнорирует `conditions_json` и `source_code` (`GAP-03`) |
| A48 | P2 | ИИ без записи / при недоступном провайдере | `calls.router.js` | `LeadDrawer.jsx` | — | Static audit | `IMPLEMENTED` | `BLOCKED` / `NOT_RUN` | Показывает «Не настроено»/«NO_RECORDING», но нет автотеста |
| A49 | P2 | ИИ на разрешённой RU/TJ контрольной выборке | `060`, `calls.router.js` (нет worker) | `LeadDrawer.jsx` | — | Static audit | `NOT_IMPLEMENTED` | `FAIL` (нет worker) + `BLOCKED` (нет ключа/выборки) | Нет фонового обработчика `QUEUED`, получения аудио Moizvonki и вызова OpenAI (`GAP-02`) |
| A50 | P0 | Регрессия договоров, ПКО/РКО, касс, рассрочки, объектов | Существующие модули не менялись | Существующие модули (9 несвязанных тестов падали в R01) | — | — | `PARTIAL` | `NOT_RUN` (актуальный полный прогон) | Нужен полный прогон после R09.1.1 (`R09.3`) |
| A51 | P0 | Миграция и откат с сохранением данных | `060`–`070`, `rollback_060`, `app_rollback_060_061` | — | `060`, `061` (PGlite) | PGlite | `PARTIAL` | `NOT_RUN` (062–070 rollback + staging) | Отсутствуют rollback-скрипты для миграций `062`–`070`; нет прогона на копии PostgreSQL (`GAP-07`) |
| A52 | P1 | Нагрузка и разрыв сети (`N-02`) | — | — | — | Staging load | `NOT_IMPLEMENTED` | `BLOCKED` / `NOT_RUN` | Нет нагрузочного стенда и прогона `N-02` (`GAP-09`) |

---

## 4. Проверки, требующие обязательного Staging-контура

Результаты `PGlite` и `jsdom`/моков **не заменяют** следующие проверки:
1. **Реальный Supabase PostgreSQL + PostgREST RPC:** применение миграций `060`–`070`, проверка `RLS`/`GRANT`, реального `search_path` и `app_rollback` с сохранением данных (`A51`).
2. **Два независимых backend-процесса:** одновременный запуск `OutboxWorkerService` и конкурентное распределение/назначение лидов (`A10`, `A11`, `A45`, `A46`) с проверкой `fn_claim_outbox_batch` и CAS 409.
3. **Браузерный E2E (Playwright/реальный браузер):** полный путь от входящего обращения до `LeadDrawer` → «Оформить сделку» → `SIGNED` → `ClientsPage` → отчёты/Excel (`A01`, `A15`, `A25`, `A34`–`A38`, `A43`, `A50`).
4. **Нагрузочное тестирование `N-02` (`A52`):** 2x объём обезличенных данных, 2 backend-процесса + 10 пользовательских сессий, замеры P95 (`≤ 1.5 с` чтение, `≤ 3 с` push / `≤ 7 с` polling), разрыв сети.
5. **Разрешённые живые каналы:**
   - **Meta / Instagram:** реальный тестовый бизнес-аккаунт и тестовый профиль (`A02`, `A30`–`A33`).
   - **Moizvonki:** реальный callback и получение аудиозаписи (`F-12`, `F-20`).
   - **OpenAI (`OPENAI_API_KEY` + `CALL_AI_ANALYSIS_ENABLED=true`):** контрольная выборка RU/TJ после реализации worker (`A49`).

---

## 5. Реестр обнаруженных пробелов и дефектов (задачи для исполнителей)

### `GAP-01` (`P0`) — **CLOSED в PGlite** (остаётся 2-процессный тест на staging PostgreSQL) — Транзакционное проектное автораспределение и обработчик пула `unassigned`
- **Реализация:** Миграция `071_r09_2_gap01_transactional_distribution.sql` (`fn_select_and_assign_lead_atomic`, `fn_run_lead_pool_batch`), `roundRobin.service.js`, `leadPoolWorker.service.js`, `run-lead-pool-worker.js`, `leads.router.js`, `outboxWorker.service.js`.
- **Доказательство:** `071_r09_2_gap01_distribution.test.js` (5/5 `PASS` в PGlite), `persistent_distribution_settings.test.js` (12/12 `PASS`).
- **Остаток на staging (`NOT_RUN`):** `node server/src/scripts/verify-gap01-two-process-pg.mjs` против реального PostgreSQL (`STAGING_DATABASE_URL`).

### `GAP-02` (`P2`) — Отсутствует фоновый обработчик очереди ИИ-анализа звонков (`F-20` / `A49`)
- **Последствие:** Записи в `call_ai_analyses` со статусом `QUEUED` никогда не переходят в `PROCESSING`/`READY`/`FAILED`; загрузка аудио из Moizvonki и вызов OpenAI не выполняются даже при наличии `OPENAI_API_KEY`.
- **Критерий исправления:** Реализован безопасный worker (по аналогии с outbox/lease), который забирает `QUEUED`, получает аудиозапись Moizvonki по разрешённому контуру, вызывает OpenAI (при `CALL_AI_ANALYSIS_ENABLED=true`), сохраняет структурированный результат с фрагментами/ошибками без утечки ключей в логи и подтверждается на контрольной выборке RU/TJ.
- **Зависимости:** `060` (`call_ai_analyses`), `calls.router.js`, доступ Moizvonki и `OPENAI_API_KEY`.
- **Задача для исполнителя:** Реализовать `CallAiWorkerService` с получением аудио Moizvonki, адаптером OpenAI, обработкой ошибок/ретраев и изолированным тестом с моками + чеклистом для RU/TJ.

### `GAP-03` (`P2`) — Отсутствует UI конструктора правил `/crm-rules` и неточный preview (`F-19` / `A47`)
- **Последствие:** Администратор/директор не может просматривать, создавать, предварительно проверять и включать правила `crm_automation_rules` из интерфейса CRM; `POST /crm-rules/:id/preview` считает все открытые лиды проекта без учёта `conditions_json` и `source_code`.
- **Критерий исправления:** В `client/src` добавлен экран управления `/crm-rules` (список, форма из whitelist событий/действий, dry-run preview, переключатель, журнал `crm_automation_executions`); `POST /crm-rules/:id/preview` применяет те же условия фильтрации, что и `evaluateRuleConditions`.
- **Зависимости:** `automation.router.js`, `OutboxWorkerService`.
- **Задача для исполнителя:** Доработать логику `POST /crm-rules/:id/preview` в `automation.router.js` и реализовать UI-страницу `/crm-rules` с тестами `vitest`.

### `GAP-04` (`P1`) — Отсутствует UI поиска и объединения дублей контактов (`F-07`)
- **Последствие:** При появлении дублей контактов (например, разные каналы без подтверждённого телефона) оператор не может выполнить контролируемое объединение с предпросмотром переноса истории и защитой лидов с договорами.
- **Критерий исправления:** Реализованы backend API поиска/предпросмотра/объединения контактов (с запретом удаления контакта/лида с `SIGNED`-сделкой и аудитом) и соответствующий UI в карточке/списке контактов.
- **Зависимости:** `060` (`contacts`), `ClientsPage.jsx`.
- **Задача для исполнителя:** Реализовать API и UI ручного объединения дублей контактов с предпросмотром и защитой договоров.

### `GAP-05` (`P0`) — Отсутствует UI назначения проектных прав существующим пользователям (`F-03` / `A29`)
- **Последствие:** Проектные права (`all_projects_access`, `projectIds`) можно изменить только прямым вызовом `PUT /api/users/:id/project-access`, но не через интерфейс управления пользователями.
- **Критерий исправления:** В экране управления пользователями (`ADMIN`) есть форма выбора `all_projects_access` и списка проектов, вызывающая `PUT /api/users/:id/project-access`.
- **Зависимости:** `users.router.js`, `070` (`fn_set_user_project_access`).
- **Задача для исполнителя:** Добавить управление проектными допусками в UI списка/карточки пользователя и покрыть тестом `vitest`.

### `GAP-06` (`P1`) — Неполные формулы аналитики (`F-16`–`F-18`, `A39`, `A43`)
- **Последствие:** В `salesAnalytics.service.js` и `managerPerformance.service.js` отсутствуют медиана / P90 / P95 времени первого ответа и поэтапная когортная конверсия; не подтверждена сквозная сходимость клика на KPI-цифру с детализацией и Excel-выгрузкой на реальной БД.
- **Критерий исправления:** Реализованы расчёты медианы, P90 и P95 первого ответа, поэтапная когортная конверсия и интеграционный тест сходимости KPI ↔ drilldown ↔ Excel.
- **Зависимости:** `salesAnalytics.service.js`, `managerPerformance.service.js`, `salesManagementExport.service.js`.
- **Задача для исполнителя:** Добавить расчёт медианы/P90/P95 и поэтапной когорты в сервисы отчётов + тесты сходимости с Excel.

### `GAP-07` (`P0`) — Отсутствуют rollback-скрипты для миграций `062`–`070` и staging-прогон отката (`A51`)
- **Последствие:** При необходимости отката после применения миграций `062`–`070` нет готового, проверенного на копии PostgreSQL плана отката с сохранением пост-релизных данных.
- **Критерий исправления:** Подготовлены совместимые rollback-скрипты (или задокументированная процедура сохранения данных без разрушения) для `062`–`070` и проверены на копии PostgreSQL.
- **Зависимости:** Миграции `060`–`070`.
- **Задача для исполнителя:** Подготовить и протестировать на PGlite/копии PostgreSQL rollback-процедуру для `062`–`070` с сохранением новых данных.

### `GAP-08` (`P0`) — Не подтверждён UI ввода точного времени `due_at` на `TasksPage` (`F-13` / `A19`)
- **Последствие:** Точные сроки `due_at` поддержаны на backend и в `LeadDrawer`, но работа с ними на общей `TasksPage` не подтверждена тестом/UI.
- **Критерий исправления:** На `TasksPage` поддержано отображение/создание/редактирование `due_at` с часовым поясом проекта и покрыто `vitest`-тестом.
- **Зависимости:** `tasks.router.js`, `TasksPage`.
- **Задача для исполнителя:** Проверить и при необходимости доработать форму/отображение `due_at` на `TasksPage` + добавить тест.

### `GAP-09` (`P1`) — Отсутствует нагрузочный стенд и замеры `N-02` (`A52`)
- **Последствие:** Нет объективных замеров P95 (≤1.5с / ≤3с / ≤7с) при 2x нагрузке, 2 backend-процессах и 10 сессиях.
- **Критерий исправления:** Подготовлен нагрузочный скрипт и проведён прогон на staging-контуре с фиксацией результатов P95 в отчёте.
- **Зависимости:** Staging-среда (`R09.4`).
- **Задача для исполнителя:** Подготовить сценарий нагрузочного замера `N-02` и выполнить его на staging в рамках `R09.4`.
