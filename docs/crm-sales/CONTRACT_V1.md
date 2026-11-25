# CONTRACT_V1.md — Единый контракт TOZON CRM (Sales Completion V1.0)

**Версия:** `1.0.0`  
**Источник истины:** `TOZON_CRM_SALES_COMPLETION_TZ_V1.md`  
**Даты:** хранение в `UTC` (`TIMESTAMPTZ`), бизнес-время по умолчанию `Asia/Dushanbe` (`UTC+5`), диапазоны `[from, to)`.  
**Идентификаторы:** сериализуются безопасно для больших целых (строка или безопасный integer), на сервере валидируются без потери точности.

---

## 1. Канонические этапы воронки (`stage`, F-01)

| Код `stage` | Название | Исторический `status` (совместимость) | Основание |
|---|---|---|---|
| `NEW` | Новый лид | `NEW` | Входящее или ручное создание |
| `IN_PROGRESS` | В работе | `IN_PROGRESS` | Взято в обработку / попытка контакта |
| `NEGOTIATION` | Переговоры | `NEGOTIATION` | Зафиксирован интерес и обсуждение |
| `MEETING_SCHEDULED` | Встреча назначена | `NEGOTIATION` | Задача/событие встречи с `due_at` |
| `SHOWING_DONE` | Показ проведён | `NEGOTIATION` | Подтверждённое событие показа с результатом |
| `RESERVED` | Бронь | `NEGOTIATION` | Активная сделка `RESERVED` |
| `CONTRACT_PREP` | Подготовка договора | `NEGOTIATION` | Сделка `DRAFT` / подготовка договора |
| `SIGNED` | Договор подписан | `WON` | Подтверждённая сделка `SIGNED` (read-only для drag-and-drop) |
| `LOST` | Отказ / закрыто | `LOST` | Обязателен `lost_reason_code` (+ комментарий для `OTHER`) |

- Исторический `status = 'WON'` без связанной сделки `SIGNED` **никогда** не получает `stage = 'SIGNED'` — помечается `legacy_unverified_won: true`.
- Перемещение этапа (`PATCH /api/leads/:id/status`) **не** создаёт `first_contact_at` / `first_response_at` / `first_contact_confirmed_at`.

---

## 2. Единый объект фильтров (`GET /api/leads`, `GET /api/leads/stats`, экспорт)

`projectId`, `managerId`, `source`, `accountId`, `stage` (или `status`), `createdFrom`, `createdTo`, `taskState` (`NO_TASK` | `OVERDUE` | `HAS_OPEN` | `PAUSED`), `unread` (`true`/`false`), `archive` (`active` | `archived` | `all`), `lostReason`, `quickFilter` (`ALL` | `MY` | `NEW` | `UNASSIGNED` | `AWAITING_RESPONSE` | `NO_TASK` | `OVERDUE` | `UNREAD` | `REPEAT` | `CLOSED`), `search`, `groupBy` (`none` | `manager`), `cursor`, `limit`.

Ответ списка:
```json
{
  "status": "success",
  "data": {
    "leads": [],
    "total": 0,
    "nextCursor": null,
    "appliedFilters": {},
    "scope": { "role": "DIRECTOR", "restrictedToSelf": false },
    "generatedAt": "2026-11-25T06:00:00.000Z"
  }
}
```

---

## 3. Коды ошибок и статусы HTTP

- `400 VALIDATION_ERROR` — неполные или невалидные данные (напр. отказ без причины, `OTHER` без комментария, некорректный переход).
- `403 FORBIDDEN` — недостаточно прав на ресурс/проект/диалог/вложение (возвращается сервером, включая подписки).
- `409 CONFLICT` — конфликт версии/CAS (`version` не совпала при назначении или смене этапа); ответ содержит актуальную карточку `current`.
- `429 RATE_LIMIT` — превышение лимита запросов/внешнего API.
- `504 TIMEOUT` / `502 PROVIDER_ERROR` — временная недоступность внешнего канала.
- Отправка сообщений различает: `sending`, `confirmed`, `unknown` (`accepted_but_unsaved` — требуется сверка без слепого повтора), `error`.
