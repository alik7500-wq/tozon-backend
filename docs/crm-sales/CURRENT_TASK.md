# CURRENT_TASK.md

- **ID задачи:** `R06.1` — Согласование ошибок API и жизненного цикла попытки отправки Instagram
- **Статус:** `DONE` (реальный Axios interceptor + PGlite HTTP `fn_instagram_send_claim` + `InstagramReplyComposer` lifecycle тесты пройдены; 2-процессный PostgreSQL и живая Meta — `NOT_RUN`)
- **Ветки:**
  - `tozon-backend`: `feat/crm-sales-completion`
  - `tozon-crm`: `a00`
- **Что сделано:**
  - `client/src/api/client.js`: удалён фиктивный `normalized.response` для сетевых/таймаут-ошибок `/integrations/instagram/*`; сохраняются `hasHttpResponse`, `isTimeout`, `isNetworkError`, `networkCode`/`code` и `status`; добавлены объяснения для `SEND_IN_PROGRESS`, `IDEMPOTENCY_CONFLICT`, `INSTAGRAM_SEND_UNCONFIRMED`, `INSTAGRAM_ACCESS_DENIED`.
  - `server/src/modules/integrations/instagram-send.service.js`: при ошибке хранилища после вызова поставщика возвращается `deliveryStatus: 'unknown'` вместо retryable `503`.
  - `client/src/features/instagram/InstagramReplyComposer.jsx`: разделены `draftText` и `operation` (`idempotencyKey`, `sentText`, `state: idle|sending|confirmed|failed|unknown`); `SEND_IN_PROGRESS` и сетевые/таймаут-сбои переводятся в `unknown`; после `failed` требуется явная кнопка «Начать новую попытку» с новым ключом; при `unknown` сброс предупреждает о возможной доставке; поздний ответ или сверка старой операции не затирает новый черновик или другой диалог.

## Обязательно зарегистрировано в R07
- Первая страница списка диалогов не является полной проверкой сохранения доступа к выбранному диалогу; очистку кэша/черновиков проверять отдельно.

## Следующая задача
- `R07` — Автообновление, сохранение догруженных страниц и проверка отзыва доступа/очистки кэша (в ветках `feat/crm-sales-completion` и `a00`).
