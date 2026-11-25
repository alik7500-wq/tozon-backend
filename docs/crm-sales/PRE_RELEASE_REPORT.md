# Предрелизный отчёт TOZON CRM (Sales Completion V1.0)

**Дата:** 2026-11-25  
**Статус готовности:** **ЧАСТИЧНО ГОТОВО / НЕ ГОТОВО К PRODUCTION DEPLOY** (есть `BLOCKED` и `NOT_RUN` по внешним каналам, ИИ, staging-нагрузке и E2E на реальной БД; production и `main` не изменялись).

---

## 1. Реестр миграций и проверка на конфликты

Проверены все файлы в `server/src/db/migrations/` (включая `origin/main` `e3464dd85f2d39d243c895864c9da35b513e7c34`):
- Последняя существующая миграция: `059_marketing_commission_scale_0_2_3_4_no_5pct_floor.sql`.
- Новая миграция: `060_crm_sales_completion_foundation.sql` + `rollback_060_crm_sales_completion_foundation.sql`.
- **Конфликтов нумерации нет.**

---

## 2. Изолированная проверка PostgreSQL (PGlite)

Проведено 2 интеграционных набора тестов на изолированной PostgreSQL-совместимой БД (`@electric-sql/pglite`):
1. `src/db/migrations/__tests__/060_crm_sales_completion_foundation.test.js` (**PASS**, 1/1):
   - двойное идемпотентное применение `060`;
   - сохранение исторического `WON` как `CONTRACT_PREP` (никогда не превращается в `SIGNED`);
   - вставка лида с `phone IS NULL` (A08);
   - множественные открытые `CALL`-задачи с разными `idempotency_key` (F-13.7);
   - CAS-проверка версии в `fn_assign_lead_atomic` (`VERSION_CONFLICT` 409);
   - RLS/GRANT (`anon`/`authenticated` не имеют прав на новые таблицы);
   - чистый откат через `rollback_060_crm_sales_completion_foundation.sql`.
2. `src/db/migrations/__tests__/060_pre_release_isolation.test.js` (**PASS**, 2/2):
   - конкурентное назначение двумя одновременными вызовами `fn_assign_lead_atomic` с `version=1` (`Promise.all`): ровно 1 `ASSIGNED` (версия 2) и 1 `VERSION_CONFLICT`, в `lead_assignment_history` ровно 1 запись;
   - `crm_event_outbox`: дедупликация по `idempotency_key`, переход `FAILED` → выборка due retry → `DONE`.

---

## 3. Общие прогоны тестов, сборки и линтера

- **Frontend build (`npm.cmd --prefix client run build`):** **PASS** (4.03s).
- **Frontend lint (`npm.cmd --prefix client run lint`):** **FAIL** — 17 errors, 808 warnings на 316 файлах (преимущественно в предсуществующих файлах других модулей: `PanoramaHotspot.jsx`, `HotspotEditor.jsx`, `CommercialOfferModal.jsx`, `main.jsx`).
- **Frontend Vitest (`npx.cmd --prefix client vitest run client/src --environment jsdom`):** **80 passed / 9 failed** из 89 файлов (420 passed / 30 failed из 450 тестов).
  - Все CRM/Sales/Analytics/Instagram UI-тесты (`leads/`, `crm/`, `instagram/`, `analytics/`, `sync-crm-contract.test.js`) **PASS** (включая `LeadsWorkspaceCompletion.test.jsx`, `SalesManagementDashboard.test.jsx`, `SalesAnalyticsPage.test.jsx`, `LeadControlView.test.jsx`, `ClientsPage.buyers.test.jsx`, `InstagramInboxPage.test.jsx`, `InstagramAccounts.test.jsx`, `InstagramReplyComposer.test.jsx`).
  - 9 упавших файлов относятся к другим модулям (например, `finance/__tests__/income_edit.test.jsx`).
- **Backend Vitest (целевой набор `migrations/__tests__/`, `leads/__tests__/`, `lead-intake/`, `calls/`, `integrations/`):** **9 passed / 9 файлов, 38/38 тестов PASS**.
- **Backend Vitest (общий `npm.cmd --prefix server test`):** остановлен после таймаута на одном из старых наборов; часть интеграционных тестов с `connection.js` без реальных `SUPABASE_URL`/`SUPABASE_KEY` в окружении не запускаются (`Missing SUPABASE_URL or SUPABASE_KEY`).

---

## 4. Матрица требований F-01–F-20 и N-01–N-03

| ID | Реализация (файлы / методы) | Проверка и среда | Статус |
|---|---|---|---|
| F-01 | `leadDomain.js` (`CANONICAL_STAGES`), `leads.router.js` (`GET /stages`), `LeadKanbanView.jsx` | Unit (`leadDomain.test.js`), UI (`LeadsWorkspaceCompletion.test.jsx`) | **PASS** (unit/UI mock); **NOT_RUN** на live API |
| F-02 | `leadDomain.js` (`validateStageTransition`), `leads.repository.js` (`updateStatus`), `LeadDrawer.jsx` | Unit (`leadDomain.test.js`) | **PASS** (unit); **NOT_RUN** на live API |
| F-03 | `leads.router.js` (`GET /` фильтры, `total`, `nextCursor`), `LeadsPage.jsx` (3 вида, фильтры) | UI (`LeadsWorkspaceCompletion.test.jsx`) | **PASS** (UI mock); **NOT_RUN** на live API (>page) |
| F-04 | `LeadKanbanView.jsx` (телефон/пусто, проект, ответственный, бюджет/источник) | UI (`LeadsWorkspaceCompletion.test.jsx`), build | **PASS** (сборка/UI) |
| F-05 | `060_...sql` (`crm_event_outbox`), `intake.migration.test.js` | PGlite (`060_pre_release_isolation.test.js`, `intake.migration.test.js`) | **PASS** (PGlite); **NOT_RUN** для live webhook |
| F-06 | `LeadIntakeModal.jsx`, `intake.router.js`, `060_...sql` (`source_code`, `utm_data`, `is_historical_import`) | UI (`LeadIntakeModal.test.jsx`), PGlite (`intake.migration.test.js`) | **PASS** |
| F-07 | `060_...sql` (`contacts`, `uq_contacts_instagram_identity`), `ClientsPage.jsx` | PGlite (`060_...test.js`) | **PARTIAL / NOT_RUN** (UI ручного объединения дублей не реализован) |
| F-08 | `060_...sql` (`lead_distribution_settings` с `project_id`, `round_robin_cursor`, `pool_reason`) | Схема в PGlite | **NOT_RUN** (проектный UI настроек распределения в `SettingsPage` требует интеграции с live API) |
| F-09 | `060_...sql` (`fn_assign_lead_atomic` с `p_expected_version`), `leads.repository.js`, `leads.router.js` (409) | PGlite (`060_pre_release_isolation.test.js`) | **PASS** (PGlite CAS 409) |
| F-10 | `LeadDrawer.jsx` (лента, заметки, интересы, сделки, SMS, ИИ-звонки, кнопка «Оформить сделку») | Build + ручной аудит | **NOT_RUN** E2E в браузере |
| F-11 | `instagram-inbox.router.js`, `InstagramInboxPage.jsx`, `InstagramReplyComposer.jsx`, `AuthContext.jsx` | UI (`Instagram*.test.jsx`) | **PASS** (UI mock); **BLOCKED** на live Meta (нужен токен/тестовый профиль) |
| F-12 | `leadDomain.js` (`classifyCommunicationEffect`), `leads.repository.js` (`recordFirstContact`), `leads.router.js` (`POST /:id/communications`) | Unit (`leadDomain.test.js`) | **PASS** (unit); **NOT_RUN** на live API |
| F-13 | `060_...sql` (`tasks.due_at`, `due_date_only`, снятие `uq_tasks_open_lead_call`), `tasks.service.js`, `tasks.repository.js` | PGlite (`060_...test.js`) | **PASS** (схема/PGlite); **NOT_RUN** UI-форма точного времени на `TasksPage` |
| F-14 | `leadSla.service.js`, `LeadControlView.jsx` | UI (`LeadControlView.test.jsx`) | **PASS** (UI); **NOT_RUN** e2e эскалации |
| F-15 | `ClientsPage.jsx`, `DealWizardBuyerEligibility.test.jsx`, `leadDomain.js` (`resolveCanonicalStage`) | UI (`ClientsPage.buyers.test.jsx`, `DealWizardBuyerEligibility.test.jsx`), Unit | **PASS** |
| F-16–F-18 | `SalesAnalyticsPage.jsx`, `SalesManagementDashboard.jsx`, `ManagerPerformanceView.jsx`, `reports/` | UI (`SalesAnalyticsPage.test.jsx`, `SalesManagementDashboard.test.jsx`) | **PASS** (существующие отчёты); **NOT_RUN** сквозная сверка новых когорт на live БД |
| F-19 | `060_...sql` (`crm_automation_rules`, `crm_automation_executions`), `automation.router.js` (`/crm-rules`) | Код реализован | **NOT_RUN** (нет отдельного UI-экрана конструктора `/crm-rules` и теста) |
| F-20 | `060_...sql` (`call_ai_analyses`), `calls.router.js`, `LeadDrawer.jsx` (вкладка «ИИ-звонки») | Схема в PGlite, UI-сборка | **BLOCKED** (нет `OPENAI_API_KEY` / разрешённой контрольной выборки RU/TJ) |
| N-01 | `leads.router.js` (`GET /updates`), `LeadsPage.jsx`, `InstagramInboxPage.jsx` | UI (`InstagramInboxPage.test.jsx`) | **PASS** (Instagram polling); **NOT_RUN** на live `leads/updates` |
| N-02 | Целевые SLA P95 (≤1.5с / ≤3с / ≤7с) при нагрузке 2x, 2 backend + 10 сессий | — | **BLOCKED / NOT_RUN** (отсутствует staging-контур и нагрузочный стенд) |
| N-03 | `060_...sql` (`crm_event_outbox`) | PGlite (`060_pre_release_isolation.test.js`) | **PASS** (PGlite outbox retry/dedup) |

---

## 5. Матрица приёмки A01–A52

- **PASS (на unit / PGlite / UI mock):** `A08`, `A09`, `A10`, `A11`, `A16`, `A17`, `A18`, `A23`, `A24`, `A25`, `A26`, `A27`, `A30`, `A31`, `A32`, `A33`, `A34`, `A35`, `A36`, `A37`, `A38`, `A42`, `A45`, `A46`, `A51` (DB rollback `060` в PGlite).
- **NOT_RUN (требуется тестовый контур с применённой миграцией `060` и live API):** `A01`, `A03`, `A04`, `A05`, `A06`, `A07`, `A12`, `A13`, `A14`, `A15`, `A19`, `A20`, `A21`, `A22`, `A28`, `A29`, `A39`, `A40`, `A41`, `A43`, `A44`, `A47`, `A50` (полный E2E в браузере), `A52`.
- **BLOCKED (требуются внешние учётные данные / доступы владельца):**
  - `A02` (live Meta webhook → тестовый профиль Instagram),
  - `A48`–`A49` (разрешённый контур и API-ключ ИИ `OPENAI_API_KEY` + контрольная выборка звонков RU/TJ).

---

## 6. Недостающие внешние доступы и условия (раздел 20 ТЗ)

1. **Staging / тестовая копия Supabase PostgreSQL** (с `SUPABASE_URL` / `SUPABASE_KEY`) для применения миграции `060` и прогона API-тестов, зависящих от `connection.js`.
2. **Meta / Instagram:** валидный OAuth-токен тестового бизнес-аккаунта и согласованный тестовый диалог для E2E-проверки `A02`/`A30`–`A33` без отправки сообщений реальным клиентам.
3. **Телефония (Moizvonki):** тестовый доступ и разрешённые аудиозаписи звонков на русском и таджикском языках.
4. **Провайдер ИИ (`OPENAI_API_KEY` и флаг `CALL_AI_ANALYSIS_ENABLED=true`):** требуется явное разрешение владельца на передачу записей внешнему провайдеру.

---

## 7. Порядок безопасного выпуска

1. Снять резервную копию БД и проверить восстановление.
2. Применить `060_crm_sales_completion_foundation.sql` на **staging/тестовой копии** и прогнать интеграционные E2E-тесты (`A01`–`A52`).
3. Оставить `CALL_AI_ANALYSIS_ENABLED=false` и новые правила `crm_automation_rules.is_enabled=false` по умолчанию при выкладке.
4. После review и прохождения staging-приёмки выполнить merge `feat/crm-sales-completion` (`server`) → `main` и `a00` (`client`) → `main`.
5. Проверить deployed SHA на production (read-only smoke + тестовый профиль).
