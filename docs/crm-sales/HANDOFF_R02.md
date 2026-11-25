# HANDOFF_R02.md — Безопасная миграция и откат

- **Задача:** `R02`
- **Статус:** `DONE` (изолированная PGlite-проверка пройдена; staging/production БД не изменялись)
- **Репозиторий / Ветка:** `alik7500-wq/tozon-backend` (`server/`), ветка `feat/crm-sales-completion`

## Изменённые и добавленные файлы
- `server/src/db/migrations/061_harden_fn_assign_lead_atomic_and_app_rollback.sql` — следующая аддитивная миграция: удаляет неоднозначную 6-аргументную перегрузку `fn_assign_lead_atomic` из 052 (7-аргументная с `DEFAULT NULL` обслуживает и 6-, и 7-аргументные вызовы без `is not unique`), отзывает `EXECUTE` у `PUBLIC`, `anon`, `authenticated` на всех перегрузках и ограничивает права на `060`-последовательности ролями `service_role, postgres`.
- `server/src/db/migrations/app_rollback_060_061_preserve_data.sql` — безопасный откат приложения без `DROP TABLE`/`DROP COLUMN` и без потери накопленных данных.
- `server/src/db/migrations/rollback_060_crm_sales_completion_foundation.sql` — добавлен guard `tozon.allow_destructive_test_cleanup = 'YES_TEST_ONLY'` (только одноразовые тестовые БД).
- `server/src/db/migrations/__tests__/061_safe_migration_and_rollback.test.js` — PGlite-тест идемпотентности `060`+`061`, проверки `SET ROLE anon/authenticated/service_role` и сохранности данных при откате.
- `server/src/db/migrations/__tests__/060_crm_sales_completion_foundation.test.js` — обновлён для явного указания тестового флага перед destructive cleanup.

## Проверки
- `npm.cmd --prefix server test -- src/db/migrations/__tests__/060_crm_sales_completion_foundation.test.js src/db/migrations/__tests__/060_pre_release_isolation.test.js src/db/migrations/__tests__/061_safe_migration_and_rollback.test.js` → **PASS** (3 файла, 4/4 теста, среда: изолированный PGlite).

## Оставшиеся ограничения
- Проверка выполнена в PGlite; применение на staging Supabase/PostgreSQL требует `SUPABASE_URL`/`SUPABASE_KEY` и отдельного разрешения.
- Остаются задачи `R03`–`R09`.
