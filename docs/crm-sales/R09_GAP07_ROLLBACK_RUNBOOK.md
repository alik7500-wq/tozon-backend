# R09 / GAP-07 — Единый Runbook совместимого отката приложения с сохранением данных

## 1. Инвентаризация версий и миграций (`060`–`074`)
- **Базовая точка отката (`origin/main`):** `261018ef557e54fbcfd0b31475fcb538c164201f`
- **Целевая ветка доработки (`feat/crm-sales-completion`):** база `55bcdd02976098a39317fecece484e97c2f58f87` (+ коммит `GAP-07`)
- **Политика схемы:** Все миграции `060`–`074` являются **аддитивными / совместимыми**. При откате кода расширенная схема БД **сохраняется** (`app_rollback_060_074_preserve_data.sql`), чтобы не уничтожать пост-релизные контакты, лиды, переписки, задачи, очередь outbox, `UNKNOWN`-отправки Instagram и договоры.

| Миграция | Назначение | Совместимость при откате кода |
|---|---|---|
| `060_crm_sales_completion_foundation.sql` | `contacts`, `lead_communications`, `lead_stage_history`, `crm_event_outbox`, `crm_automation_*`, `call_ai_analyses`, `leads.stage`, `tasks.due_at`, `fn_assign_lead_atomic` | Совместима; `app_rollback_060_074_preserve_data.sql` синхронизирует `leads.status` от `SIGNED`-сделок |
| `061_harden_fn_assign_lead_atomic_and_app_rollback.sql` | Унификация перегрузок `fn_assign_lead_atomic` | Совместима |
| `062_atomic_lead_stage_transition.sql` / `063_...sql` | `fn_update_lead_stage_atomic`, отмена продажных задач при `LOST` | Совместима (закрытые `EXECUTE`) |
| `064_unified_lead_query_and_cursor.sql` / `065_...sql` | `fn_query_leads_unified` | Совместима |
| `066_user_project_access.sql` | `users.all_projects_access`, `user_project_access` | Совместима |
| `067_instagram_send_idempotency.sql` | `crm_instagram_send_operations` (`idempotency_key`, `external_message_id`, `UNKNOWN`) | Совместима |
| `068` / `069` / `070` | `crm_outbox_settings`, триггеры outbox, `fn_apply_outbox_effect`, `fn_set_user_project_access`, диагностика | При откате `crm_outbox_settings.is_enabled` переводится в `FALSE`, lease сбрасываются безопасно |
| `071` / `072` / `073` / `074` | `fn_select_and_assign_lead_atomic`, `fn_run_lead_pool_batch`, `pool_next_attempt_at`, проектный допуск в `fn_assign_lead_atomic` | При откате `pool_worker_enabled` переводится в `FALSE` |

---

## 2. Матрица совместимости «Версия приложения ↔ Схема БД»

| Версия приложения | Схема `059` | Схема `060–074` (после `app_rollback_060_074_preserve_data.sql`) | Примечание |
|---|---|---|---|
| `origin/main` (`261018ef...`) | Штатная база | **Совместима** | Ограничение: UI/API `origin/main` не отображает новые поля (`due_at` exact UI, `ProjectAccessModal`, `/crm-rules`), но данные сохраняются; пользователи без `user_project_access`/`all_projects_access` ограничиваются `fn_assign_lead_atomic` |
| `feat/crm-sales-completion` | **Несовместима** | Штатная цель | Требует применения `060`–`074` |

---

## 3. Порядок отката приложения (Runbook)

1. **Остановка фоновых обработчиков и автоматизаций:**
   - Выставить переменные окружения `OUTBOX_WORKER_ENABLED=false`, `LEAD_POOL_WORKER_ENABLED=false`, `CALL_AI_ANALYSIS_ENABLED=false`.
   - Остановить процессы `run-outbox-worker.js` и `run-lead-pool-worker.js`.
2. **Завершение или безопасное истечение активных lease + сохранение данных:**
   - Дождаться завершения текущих батчей (до 60 с) либо выполнить идемпотентный скрипт:
     `psql "$DATABASE_URL" -f server/src/db/migrations/app_rollback_060_074_preserve_data.sql`
   - Скрипт переводит `crm_outbox_settings.is_enabled=FALSE`, `lead_distribution_settings.pool_worker_enabled=FALSE`, `crm_automation_rules.is_enabled=FALSE`, освобождает зависшие `PROCESSING`-lease в `FAILED` без удаления событий и `idempotency_key`, выравнивает `leads.status` по `SIGNED`-сделкам (legacy `WON` без `SIGNED`-договора не считается продажей) и переподтверждает закрытые `GRANT`/`RLS`.
3. **Переключение приложения на совместимую версию:**
   - Развернуть `origin/main` (`261018ef557e54fbcfd0b31475fcb538c164201f`) на backend и соответствующую стабильную версию frontend.
4. **Проверка после отката (без секретов):**
   - Проверить `/health`, чтение лидов, сделок, финансов, клиентов (`SIGNED`), сохранность `crm_instagram_send_operations` (`status='UNKNOWN'`) и отсутствие открытых `PROCESSING` lease.
5. **Повторное обновление (`re-upgrade`) на `feat/crm-sales-completion`:**
   - Развернуть `feat/crm-sales-completion`, при необходимости повторно применить миграции (всё идемпотентно).
   - **Условия безопасного возобновления обработчиков:**
     1. Проверена диагностика (`GET /api/outbox/diagnostics`, `GET /api/leads/distribution/pool-diagnostics`).
     2. Проверены `cutoff_at` и `QUARANTINED` события.
     3. Проведена сверка `UNKNOWN`-отправок Instagram по `external_message_id`.
     4. Только после этого включать `OUTBOX_WORKER_ENABLED=true` / `crm_outbox_settings.is_enabled=true` (и отдельно при необходимости `LEAD_POOL_WORKER_ENABLED`).

---

## 4. Команды изолированной проверки
- PGlite полный цикл:
  `npm.cmd --prefix server test -- src/db/migrations/__tests__/077_gap07_compatible_rollback.test.js`
- Одноразовая PostgreSQL / PostgREST проверка (только `TEST_DATABASE_URL`, без production):
  `TEST_DATABASE_URL="postgres://..." node server/src/scripts/verify-gap07-rollback-pg.mjs`
