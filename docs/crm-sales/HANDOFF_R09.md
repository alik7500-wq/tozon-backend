# HANDOFF_R09.md — R09.1 и план завершения R09

## Матрица приёмки R09.1
| Проверка | Реализация / тест | Среда | Статус |
|---|---|---|---|
| Переназначение между чтением и записью эффекта -> `RECIPIENT_STALE_REASSIGNED`, 0 эффектов на старого менеджера | `fn_apply_outbox_effect` (`070_r09_1_consistency.test.js`) | PGlite | `PASS` |
| Задержанная очередь и повтор без продления SLA; точные `meeting_at` / `callback_at` | `OutboxWorkerService` (`070_r09_1_consistency.test.js`) | PGlite | `PASS` |
| Исторический импорт -> новое живое обращение обрабатывается по обычным правилам | `070_r09_1_consistency.test.js` | PGlite | `PASS` |
| Все 4 сочетания `OUTBOX_WORKER_ENABLED` и `crm_outbox_settings.is_enabled` + override-журнал | `OutboxWorkerService`, `run-outbox-worker.js`, `outbox.router.js` (`070_r09_1_consistency.test.js`) | PGlite | `PASS` |
| Сбой/невалидные ID/non-boolean при замене проектных прав -> полный откат | `fn_set_user_project_access`, `UsersRepository.setProjectAccess` (`070_r09_1_consistency.test.js`) | PGlite | `PASS` |
| Диагностика > 1000 строк в БД и сохранение `last_success_at = NULL` при `leaseLost` | `fn_outbox_diagnostics`, `fn_outbox_preview_cutoff` (`070_r09_1_consistency.test.js`) | PGlite | `PASS` |
| 2-процессный тест на реальном PostgreSQL | — | Staging PostgreSQL | `NOT_RUN` |

## План оставшейся R09
1. **`R09.2` — Сверка всех `F/N/A` с кодом:** построчная проверка матрицы `F-01–F-20`, `N-01–N-03`, `A01–A52` по коду `feat/crm-sales-completion` и `a00` с честной классификацией (`PASS`, `NOT_IMPLEMENTED`, `NOT_RUN`, `BLOCKED`).
2. **`R09.3` — Общий прогон и регрессия:** полный прогон всех модульных и интеграционных тестов backend (`vitest`) и frontend (`vite build` + `vitest jsdom`).
3. **`R09.4` — Staging, нагрузка и разрешённые живые каналы:** прогон миграций `060–070` на изолированной staging PostgreSQL, 2-процессный конкурентный тест outbox/R06, замеры `N-02` и живая Meta-проверка при наличии токена (иначе `NOT_RUN` / `BLOCKED`).
4. **`R09.5` — Итоговый предрелизный комплект:** финальный отчёт готовности, список миграций/runbook и передача SHA на merge/deploy владельцу проекта.
