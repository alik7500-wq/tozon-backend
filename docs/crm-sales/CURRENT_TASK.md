# CURRENT_TASK.md

- **ID задачи:** `R02.1` — Исправление совместимого отката (после R02)
- **Статус:** `DONE` (на изолированной PGlite БД; проверка именованного RPC через Supabase/PostgREST вынесена в staging-приёмку)
- **Ветка (`tozon-backend`):** `feat/crm-sales-completion`
- **Что сделано:**
  - Создана новая миграция `061_harden_fn_assign_lead_atomic_and_app_rollback.sql` (не переписывает историю `060`), устраняющая конфликт перегрузки 6-аргументной (из `052`) и 7-аргументной (`DEFAULT NULL` из `060`) `fn_assign_lead_atomic` и отзывающая `EXECUTE` у `PUBLIC`, `anon`, `authenticated` со всех перегрузок + защита `BIGSERIAL` sequence.
  - Создан безопасный откат версии приложения `app_rollback_060_061_preserve_data.sql` (сохраняет все новые таблицы и накопленные данные, выравнивает `status` и сохраняет 6-аргументную совместимость).
  - `rollback_060_crm_sales_completion_foundation.sql` защищён явным session-флагом `tozon.allow_destructive_test_cleanup = 'YES_TEST_ONLY'` исключительно для одноразовых тестовых БД.
  - Добавлен и пройден PGlite-тест `061_safe_migration_and_rollback.test.js` (проверка `SET ROLE anon/authenticated/service_role` на 6- и 7-аргументных вызовах, идемпотентности и отката с сохранением данных).

## Следующая задача
- `R03` — Атомарная смена этапа (`leads.repository.js` + интеграционный тест гонки запросов).
