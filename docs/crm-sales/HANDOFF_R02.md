# HANDOFF_R02.md — Безопасная миграция и откат (обновлено по R02.1)

- **Задача:** `R02` + `R02.1`
- **Статус:** `DONE` (изолированная PGlite-проверка пройдена; staging PostgREST RPC и production БД не изменялись)
- **Репозиторий / Ветка:** `alik7500-wq/tozon-backend` (`server/`), ветка `feat/crm-sales-completion`

## Изменённые файлы (R02.1)
- `server/src/db/migrations/app_rollback_060_061_preserve_data.sql` — статус продажи при откате вычисляется строго от авторитетного источника `public.deals` (не от `leads.stage`):
  - наличие хотя бы одного `SIGNED` договора → `WON` (в т.ч. при расторжении другого договора того же лида);
  - legacy `WON` без `SIGNED` договора → выравнивается в `NEGOTIATION` (не превращается и не остаётся подтверждённой продажей);
  - `RESERVED` / `DRAFT` без `SIGNED` → `NEGOTIATION` (не `WON`);
  - расторжение последнего `SIGNED` → не остаётся `WON`;
  - история, связи и новые данные полностью сохраняются; повторный запуск идемпотентен.
- `server/src/db/migrations/061_harden_fn_assign_lead_atomic_and_app_rollback.sql` — перед удалением старой 6-аргументной перегрузки (без `CASCADE`) проверяется точная 7-аргументная сигнатура (`ARRAY['bigint','bigint','bigint','text','integer','boolean','integer']`), `pronargdefaults >= 3`, `prosecdef = TRUE` и `search_path=public, pg_temp`; при несовпадении выбрасывается `INCOMPATIBLE_FN_ASSIGN_LEAD_ATOMIC_SIGNATURE` с откатом всей транзакции.
- `server/src/db/migrations/__tests__/061_safe_migration_and_rollback.test.js` — добавлены тесты всех случаев R02.1 (включая цепочку `legacy WON + SIGNED deal -> 060 -> 061 -> app_rollback` и откат транзакции при несовместимой сигнатуре).

## Проверки (среда: изолированный PGlite)
- `npm.cmd --prefix server test -- src/db/migrations/__tests__/060_crm_sales_completion_foundation.test.js src/db/migrations/__tests__/060_pre_release_isolation.test.js src/db/migrations/__tests__/061_safe_migration_and_rollback.test.js` → **PASS** (3 файла, 5/5 тестов).

## Оставшиеся ограничения
- Проверка старого именованного RPC (`supabase.rpc('fn_assign_lead_atomic', { ... })`) через Supabase/PostgREST **не выполнялась** (в PGlite проверены только прямые SQL-вызовы) и **вынесена в обязательную staging-приёмку**.
- Применение `060` + `061` на staging/production требует `SUPABASE_URL`/`SUPABASE_KEY` и отдельного разрешения.
- Остаются задачи `R03`–`R09`.
