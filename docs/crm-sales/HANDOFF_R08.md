# HANDOFF_R08.md — Аудит производителей, контракт outbox worker, runbook и матрица приёмки

## 1. Аудит производителей событий `crm_event_outbox`
| Источник | Где сохраняется изменение | Где создаётся durable-событие | Обработчик и эффект |
|---|---|---|---|
| Ручной лид / Webhook / Instagram / прямой SQL / Импорт | `INSERT INTO public.leads` | Триггер `trg_leads_enqueue_outbox` (та же транзакция) | `LEAD_CREATED` / `LEAD_IMPORTED` -> уведомление активному менеджеру с доступом к проекту + активные `crm_automation_rules` |
| Назначение лида (`fn_assign_lead_atomic` / SQL) | `UPDATE public.leads` + `INSERT INTO lead_assignment_history` | Триггер `trg_lead_assignment_enqueue_outbox` (та же транзакция) | `LEAD_ASSIGNED` -> проверка актуального `responsible_user_id`, активности и проекта -> `user_notifications` (`dedupe_key`) + правила |
| Смена этапа / отказ (`fn_update_lead_stage_atomic`) | `UPDATE public.leads` + `INSERT INTO lead_stage_history` | Внутри `fn_update_lead_stage_atomic` (`063`, та же транзакция) | `LEAD_STAGE_CHANGED` / `LEAD_LOST` -> идемпотентные `tasks` (`MEETING`/`CALL`) по `meeting_at`/`showing_at` + `user_notifications` + правила |
| Результаты контакта (`lead_communications`) | `INSERT INTO public.lead_communications` | Триггер `trg_lead_comm_enqueue_outbox` (та же транзакция) | `COMMUNICATION_LOGGED` -> активные `crm_automation_rules` (без внешних рассылок и AI аудио) |

## 2. Команда запуска и Runbook (безопасное включение)
- **Разовый запуск CLI:** `node server/src/scripts/run-outbox-worker.js --once`
- **Фоновый цикл (вручную/под supervisor):** `node server/src/scripts/run-outbox-worker.js` (переменные: `OUTBOX_WORKER_INTERVAL_MS=5000`, `OUTBOX_WORKER_BATCH_SIZE=25`, `OUTBOX_WORKER_LEASE_SECONDS=60`).
- **Пошаговый Runbook включения:**
  1. Применить миграцию `068_outbox_worker_lease_and_controls.sql` (`is_enabled` по умолчанию `FALSE`, `cutoff_at = NOW()`).
  2. Проверить количество исторических и новых событий через `GET /api/outbox/preview-cutoff?cutoffAt=<ISO>`.
  3. Установить `OUTBOX_WORKER_ENABLED=true` на сервере (отключает старый прямой fire-and-forget путь).
  4. Включить обработку: `PATCH /api/outbox/settings` `{ "is_enabled": true, "cutoff_at": "<ISO>" }`.
  5. Мониторить `GET /api/outbox/diagnostics` (`queueSize`, `oldestPendingAgeSeconds`, `quarantinedCount`, `last_success_at`).
  6. Для разбора карантина: исправить причину и вызвать `POST /api/outbox/quarantine/:id/replay` (требуется `ADMIN`).
- **Ограничения R08:** внешние рассылки (SMS/WhatsApp/Telegram), передача аудио ИИ и повтор отправок Instagram (`R06`) в worker не включены.

## 3. Матрица приёмки R08
| Проверка | Реализация / тест | Среда | Статус |
|---|---|---|---|
| Повтор после сбоя (до эффекта и после создания эффекта до `DONE`) без дублей | `OutboxWorkerService.runOnce` (`068_outbox_worker.test.js`) | PGlite | `PASS` |
| Конкурентный захват, восстановление истёкшего lease и отказ устаревшему `lease_token` (`LEASE_LOST`) | `fn_claim_outbox_batch`, `fn_complete_outbox_event` (`068_outbox_worker.test.js`) | PGlite | `PASS` |
| Неизвестное/невалидное событие -> `QUARANTINED` без остановки очереди + контролируемый replay | `068_outbox_worker.test.js` | PGlite | `PASS` |
| Изоляция проектов, проверка закрытого/переназначенного лида и неактивного менеджера | `068_outbox_worker.test.js` | PGlite | `PASS` |
| Отключённый worker (`is_enabled = false`) и исторический `cutoff_at` + `previewCutoff` | `068_outbox_worker.test.js` | PGlite | `PASS` |
| Два независимых процесса на реальном PostgreSQL | — | Staging PostgreSQL | `NOT_RUN` |
