# HANDOFF_R08.md — R08 & R08.1: Аудит производителей, транзакционная защита эффектов, runbook и матрица приёмки

## Дополнения R08.1
1. **Обязательные задачи и календарь:** `LEAD_CREATED` и `LEAD_ASSIGNED` используют общий ключ `PRIMARY_FIRST_CONTACT` / `lead_primary_<id>` и `calculateSalesSlaDeadline(..., 15)` (`Asia/Dushanbe`). Для `NO_ANSWER`/`BUSY`/`callback_at` действует явная политика перезвона.
2. **Правила `crm_automation_rules`:** проверяются `project_id`, `source_code`, `conditions_json`; поддерживаются только `CREATE_TASK` и `IN_APP_NOTIFICATION`; неподдержанные действия никогда не помечаются `EXECUTED`.
3. **Исторический импорт:** при `process_historical_import = false` `LEAD_IMPORTED` / `is_historical_import` пропускается без свежих SLA/уведомлений/автозадач.
4. **Атомарная защита эффектов (`fn_apply_outbox_effect`):** проверка `lease_token`, `lease_expires_at > NOW()`, `leads`, `deals (status = 'SIGNED')`, `responsible_user_id`, активности пользователя и `user_project_access` выполняется в одной транзакции с записью эффектов.
5. **Безопасное переключение (`OUTBOX_WORKER_ENABLED` + `crm_outbox_settings.is_enabled`):** старый прямой путь в `LeadsRepository` отключается только когда активны оба флага (`isOutboxWorkerActive()`), исключая режим «оба выключены».

## Матрица приёмки R08 + R08.1
| Проверка | Тест / реализация | Среда | Статус |
|---|---|---|---|
| Обязательная первичная задача без дублей при `LEAD_CREATED` + `LEAD_ASSIGNED` и выключенных rules + `NO_ANSWER` | `068_outbox_worker.test.js` | PGlite | `PASS` |
| Несовпадение условий/`source_code` -> `SKIPPED`, неподдержанное действие -> карантин (не `EXECUTED`) | `068_outbox_worker.test.js` | PGlite | `PASS` |
| Исторический импорт без свежих эффектов | `068_outbox_worker.test.js` | PGlite | `PASS` |
| Истечение `lease` перед записью эффекта -> `LEASE_LOST`, 0 эффектов | `068_outbox_worker.test.js` | PGlite | `PASS` |
| `SIGNED`-договор при устаревшем `leads.stage` -> 0 открытых задач | `068_outbox_worker.test.js` | PGlite | `PASS` |
| Сбой записи `crm_automation_executions` откатывает задачу/уведомление | `068_outbox_worker.test.js` | PGlite | `PASS` |
| Конкурентный захват, восстановление lease, `cutoff_at`, сбой до/после эффекта | `068_outbox_worker.test.js` | PGlite | `PASS` |
| Два независимых процесса на реальном PostgreSQL | — | Staging PostgreSQL | `NOT_RUN` |
