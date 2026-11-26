# CURRENT_TASK.md

- **ID задачи:** `R09.1.1` — Устранение обхода выключенного outbox
- **Статус:** `DONE` (PGlite `071_r09_1_1_outbox_gate.test.js` 5/5 + `070` 6/6 + `068` 8/8 + `066` 5/5 + `062` 7/7 `PASS`; 2-процессный PostgreSQL / staging / live Meta — `NOT_RUN` / `BLOCKED`)
- **Ветки:**
  - `tozon-backend`: `feat/crm-sales-completion`
  - `tozon-crm`: `a00` (без изменений)
- **Что сделано:**
  - `OutboxWorkerService.runOnce`: централизована проверка режима (`OUTBOX_WORKER_ENABLED=true` И `crm_outbox_settings.is_enabled=true` без `ignoreEnabled === true`); при отключении или ошибке чтения `crm_outbox_settings` возвращается `{ skipped: true, reason, claimed: 0 }` без захвата событий, без эффектов и без обновления `last_success_at`.
  - `POST /api/outbox/run-once`: `ignore_enabled` принимается строго как `boolean` (строка `"false"` отклоняется с `400`), сохранены `ADMIN` + `settings.manage`, явный override логируется с `actorUserId` и `workerId`.
  - `run-outbox-worker.js`: `--force-override` разрешён только с `--once`, постоянный цикл с обходом выключателей не допускается.
  - `071_r09_1_1_outbox_gate.test.js`: добавлены проверки фактического выполнения `runOnce` (все 4 сочетания флагов, ошибка чтения настроек, HTTP `400`/`403`/`200`, CLI с/без `--force-override`) отдельно от проверок диагностики.
  - Миграция `070_r09_1_outbox_and_project_access_tx.sql`:
    - `fn_apply_outbox_effect`: проверка соответствия каждого подготовленного получателя (`assigned_user_id`, `user_id`) текущему `leads.responsible_user_id` в одной транзакции с записью эффектов (`RECIPIENT_STALE_REASSIGNED` при гонке переназначения).
    - `fn_set_user_project_access`: транзакционная замена `users.all_projects_access` и `user_project_access` с проверкой существования пользователя и всех проектов.
    - `fn_outbox_diagnostics` и `fn_outbox_preview_cutoff`: точный подсчёт в БД без ограничения 1000 строк.
  - `OutboxWorkerService`:
    - Расчёт первичного SLA от факта `lead.created_at` / `lead.assigned_at`, сохранение точных `meeting_at` / `callback_at` без молчаливого сдвига.
    - Исторический импорт подавляет только событие импорта (`LEAD_IMPORTED` / `payload.is_historical_import`), не блокируя последующие живые события.
    - `last_success_at` обновляется только при `retried=0 && quarantined=0 && leaseLost=0`; ручной override в API/CLI логируется отдельно.
  - `UsersRepository.setProjectAccess` и `users.router.js`: строгая проверка boolean, ID пользователя и всех ID проектов без молчаливого отбрасывания невалидных значений.

## План оставшейся R09
- `R09.2` — Сверка всех требований `F-01–F-20`, `N-01–N-03`, `A01–A52` с фактическим кодом (`NOT_IMPLEMENTED` / `PASS` / `NOT_RUN` / `BLOCKED`).
- `R09.3` — Общий прогон и регрессия backend + frontend.
- `R09.4` — Staging PostgreSQL (включая 2-процессную конкурентность), нагрузка `N-02` и разрешённые живые каналы.
- `R09.5` — Итоговый предрелизный комплект (без merge/deploy до решения владельца).

## Следующая задача
- `R09.2` — Сверка всех `F/N/A` с кодом.
