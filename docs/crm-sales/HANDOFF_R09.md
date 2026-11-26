# HANDOFF_R09.md — R09.1 и план завершения R09

## Матрица приёмки R09.1
| Проверка | Реализация / тест | Среда | Статус |
|---|---|---|---|
| Переназначение между чтением и записью эффекта -> `RECIPIENT_STALE_REASSIGNED`, 0 эффектов на старого менеджера | `fn_apply_outbox_effect` (`070_r09_1_consistency.test.js`) | PGlite | `PASS` |
| Задержанная очередь и повтор без продления SLA; точные `meeting_at` / `callback_at` | `OutboxWorkerService` (`070_r09_1_consistency.test.js`) | PGlite | `PASS` |
| Исторический импорт -> новое живое обращение обрабатывается по обычным правилам | `070_r09_1_consistency.test.js` | PGlite | `PASS` |
| Диагностика (`isOutboxWorkerActive` / `getDiagnostics`): все 4 сочетания флагов | `OutboxWorkerService` (`070_r09_1_consistency.test.js`) | PGlite | `PASS` |
| Фактическое выполнение `runOnce`: все 4 сочетания флагов (`0` захватов/эффектов без обоих `true`, `last_success_at` не обновляется) | `OutboxWorkerService.runOnce` (`071_r09_1_1_outbox_gate.test.js`) | PGlite | `PASS` |
| Ошибка чтения `crm_outbox_settings` -> `SETTINGS_READ_ERROR`, блокировка захвата и `last_success_at = NULL` | `OutboxWorkerService.runOnce` (`071_r09_1_1_outbox_gate.test.js`) | PGlite | `PASS` |
| `POST /api/outbox/run-once`: `ignore_enabled="false"` -> `400`, `ADMIN` + `settings.manage`, журнал `actorUserId` + `workerId` | `outbox.router.js` (`071_r09_1_1_outbox_gate.test.js`) | Express + PGlite | `PASS` |
| CLI `runOutboxCli`: соблюдение выключателей без override и запрет `--force-override` вне `--once` | `run-outbox-worker.js` (`071_r09_1_1_outbox_gate.test.js`) | Node + PGlite | `PASS` |
| Сбой/невалидные ID/non-boolean при замене проектных прав -> полный откат | `fn_set_user_project_access`, `UsersRepository.setProjectAccess` (`070_r09_1_consistency.test.js`) | PGlite | `PASS` |
| Диагностика > 1000 строк в БД и сохранение `last_success_at = NULL` при `leaseLost` | `fn_outbox_diagnostics`, `fn_outbox_preview_cutoff` (`070_r09_1_consistency.test.js`) | PGlite | `PASS` |
| 2-процессный тест на реальном PostgreSQL | — | Staging PostgreSQL | `NOT_RUN` |

## План оставшейся R09
1. **`R09.2` — Сверка всех `F/N/A` с кодом (`DONE`):** полный отчёт и реестр `GAP-01`–`GAP-09` зафиксированы в `docs/crm-sales/R09_2_REQUIREMENTS_AUDIT.md`.
2. **Закрытие `P0`-пробелов (перед `R09.3`/`R09.4`):** `GAP-01` (`RoundRobinService` + пул `unassigned`), `GAP-05` (UI проектных прав), `GAP-07` (rollback `062`–`070`), `GAP-08` (`TasksPage` `due_at`).
3. **`R09.3` — Общий прогон и регрессия:** полный прогон всех модульных и интеграционных тестов backend (`vitest`) и frontend (`vite build` + `vitest jsdom`).
4. **`R09.4` — Staging, нагрузка и разрешённые живые каналы:** прогон миграций `060–070` на изолированной staging PostgreSQL, 2-процессный конкурентный тест outbox/RoundRobin/R06, замеры `N-02` и живая проверка Meta/Moizvonki/OpenAI при наличии доступов.
5. **`R09.5` — Итоговый предрелизный комплект:** финальный отчёт готовности, список миграций/runbook и передача SHA на merge/deploy владельцу проекта.
