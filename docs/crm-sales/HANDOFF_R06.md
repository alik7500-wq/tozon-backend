# HANDOFF_R06.md — R06 & R06.1: Идемпотентная отправка Instagram, interceptor и жизненный цикл попытки

## Дополнения R06.1
- **Interceptor (`client/src/api/client.js`):** больше не подставляет фиктивный `normalized.response` при отсутствии HTTP-ответа (таймаут `ECONNABORTED`, потеря сети `ERR_NETWORK`); выставляет `hasHttpResponse`, `isTimeout`, `isNetworkError`, `status`, `code`.
- **Lifecycle (`InstagramReplyComposer.jsx`):**
  - `draftText` отделён от `operation` (`idempotencyKey`, `sentText`, `state`).
  - `SEND_IN_PROGRESS`, таймаут, потеря соединения, `SENT_NOT_SAVED`, `INSTAGRAM_SEND_UNCONFIRMED` и `5xx` -> `unknown` (требуют сверки).
  - Подтверждённый `FAILED` -> явная кнопка «Начать новую попытку» с новым `idempotency_key` (старый ключ для изменённого текста не переиспользуется).
  - При `unknown` сброс требует подтверждения предупреждения о возможной доставке; поздний ответ/сверка старой операции не очищают новый редактируемый черновик и не влияют на другой диалог.
- **Сервер (`instagram-send.service.js`):** сбой записи состояния после вызова поставщика возвращает `deliveryStatus: 'unknown'` (не `503` безопасного повтора).

## Тесты R06 + R06.1
- Backend (`PGlite` + `Supertest`): 4 файла, 29/29 тестов `PASS` (`instagram-r06-send-idempotency.test.js`, `instagram-r05-access.test.js`, `instagram-inbox-router.test.js`, `instagram-inbox.test.js`).
- Frontend (реальный Axios interceptor + `Vitest jsdom`): 6 файлов, 32/32 теста `PASS` (включая `InstagramInterceptorR061.test.jsx` 5/5).
- Два независимых процесса PostgreSQL и живая Meta API: `NOT_RUN`.
