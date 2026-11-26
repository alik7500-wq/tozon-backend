# HANDOFF_R06.md — Контракт идемпотентной отправки Instagram, сверка и матрица приёмки

## Контракт отправки и сверки
1. **`POST /api/integrations/instagram/send/:account/:contact`**
   - Body: `{ text: string, idempotency_key: string }` (`^[A-Za-z0-9_:-]{8,128}$`).
   - `409 IDEMPOTENCY_CONFLICT` при повторном использовании `idempotency_key` с другим `account_id`, `contact_id` или `text.trim()`.
   - `409 SEND_IN_PROGRESS` при параллельном запросе с тем же ключом, пока активен `lease_expires_at`.
   - Возвращает `deliveryStatus: 'confirmed' | 'unknown'`; при `unknown` внешний запрос к Meta повторно не выполняется.
2. **`POST /api/integrations/instagram/send/:account/:contact/reconcile`**
   - Body: `{ idempotency_key: string }`.
   - Проверяет те же права R05 (`protect` + `sectionAccess` + `leads.manage` + проектный/лидовый scope).
   - Восстанавливает локальную историю при `external_message_id` без повторного `send`; при отсутствии достоверного `external_message_id` сохраняет `deliveryStatus: 'unknown'` и `nextAction`.

## Матрица приёмки R06
| Проверка | Реализация / тест | Среда | Статус |
|---|---|---|---|
| Двойной клик в UI | `InstagramReplyComposer.test.jsx` | UI mocks (Vitest jsdom) | `PASS` |
| Два одновременных HTTP-запроса с одним ключом (1 `send`, второй `409 SEND_IN_PROGRESS`) | `instagram-r06-send-idempotency.test.js` | PGlite + Supertest (мок Meta) | `PASS` |
| Повтор после успешной отправки (без нового `send`) | `instagram-r06-send-idempotency.test.js` | PGlite + Supertest | `PASS` |
| Прежний ключ с изменённым текстом/получателем -> `409 IDEMPOTENCY_CONFLICT` | `instagram-r06-send-idempotency.test.js` | PGlite + Supertest | `PASS` |
| Meta приняла, запись истории не сохранилась -> восстановление при сверке без второго `send` | `instagram-r06-send-idempotency.test.js` | PGlite + Supertest | `PASS` |
| Meta приняла / ответ потерян / таймаут / падение процесса (истёкший lease) -> `unknown`, без повтора `send` | `instagram-r06-send-idempotency.test.js` | PGlite + Supertest | `PASS` |
| `unknown` сохраняется при редактировании текста и переключении/перезагрузке; статус «Принято поставщиком» | `InstagramReplyComposer.test.jsx` | UI mocks (Vitest jsdom) | `PASS` |
| Отзыв доступа перед повтором или сверкой -> `403` | `instagram-r06-send-idempotency.test.js` | PGlite + Supertest | `PASS` |
| Два независимых backend-процесса на реальном PostgreSQL | — | Staging PostgreSQL | `NOT_RUN` |
| Живая отправка и сверка с Meta Graph API | — | Live Meta API | `NOT_RUN` |

## Обязательно передано в R07
- Первая страница списка диалогов не является полной проверкой сохранения доступа к выбранному диалогу; очистку кэша/черновиков проверять отдельно.
