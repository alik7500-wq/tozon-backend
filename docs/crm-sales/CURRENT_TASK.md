# CURRENT_TASK.md

- **ID задачи:** `R06` — Отправка Instagram без дублей и обработка неопределённого результата
- **Статус:** `DONE` (PGlite HTTP `fn_instagram_send_claim` + `instagram-send.service.js` + Vitest UI тесты пройдены; проверка двумя независимыми процессами PostgreSQL и живая Meta — `NOT_RUN` из-за отсутствия среды/токена)
- **Ветки:**
  - `tozon-backend`: `feat/crm-sales-completion`
  - `tozon-crm`: `a00`
- **Что сделано:**
  - Миграция `067_instagram_send_idempotency.sql`: таблица `public.crm_instagram_send_operations` (`IN_PROGRESS | CONFIRMED | FAILED | UNKNOWN`, `UNIQUE(actor_user_id, idempotency_key)`, `request_hash`, `external_message_id`, `saved_to_history`, `lease_expires_at`) и атомарная функция `public.fn_instagram_send_claim(...)`.
  - В `instagram-send.service.js` и `instagram-inbox.router.js`:
    - `POST /api/integrations/instagram/send/:account/:contact` требует `idempotency_key`, вычисляет `request_hash` (`actorUserId`, `accountId`, `contactId`, `text.trim()`), возвращает `409 IDEMPOTENCY_CONFLICT` при смене содержимого/получателя и `409 SEND_IN_PROGRESS` при параллельной активной отправке.
    - Повтор подтверждённой операции возвращает сохранённый результат без нового вызова поставщика; при `saved_to_history = false` восстанавливает запись истории без повторной отправки.
    - Таймаут, потеря ответа или истёкший `lease_expires_at` переводят операцию в `UNKNOWN` (автоповтор к Meta запрещён).
    - Добавлен `POST /api/integrations/instagram/send/:account/:contact/reconcile` с проверкой прав R05 и сверкой по `external_message_id` (совпадение текста и времени не считается доказательством).
  - В `InstagramReplyComposer.jsx`: передача устойчивого `idempotency_key`, сохранение черновика и состояния `unknown` по `user.id + accountId + contactId` в `sessionStorage` + `draftStore`, сохранение `unknown` при редактировании текста и переключении/перезагрузке, кнопки «Сверить доставку» и «Начать новое сообщение», статус «Принято поставщиком».

## Обязательно зарегистрировано в R07
- Первая страница списка диалогов не является полной проверкой сохранения доступа к выбранному диалогу; очистку кэша/черновиков проверять отдельно.

## Следующая задача
- `R07` — Автообновление, сохранение догруженных страниц и проверка отзыва доступа/очистки кэша (в ветках `feat/crm-sales-completion` и `a00`).
