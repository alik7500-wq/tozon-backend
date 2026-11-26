# Контракт первого этапа

Все перечисленные маршруты существуют в текущей версии CRM. Изменение обработки на сервере ограничено округлением суммы в предварительном графике.

| Метод и маршрут | Назначение | Результат |
|---|---|---|
| GET /api/projects | Список ЖК для выбора | `data.projects`, в форме используются `id`, `name` |
| GET /api/deals?projectId={id} | Договоры выбранного ЖК | `data.deals` со сведениями о жителе, квартире, договоре и оплате |
| POST /api/resettlements | Сохранение черновика для ADMIN или DIRECTOR | HTTP 201, `data.id`, `data.status = DRAFT` |
| POST /api/resettlements/installment-preview | Расчёт предварительного графика для ADMIN или DIRECTOR | `data.payable_total_minor`, `currency`, `schedule`, `persisted: false` |

Тело создания черновика содержит `project_id`, `original_home_area_x100`, `compensated_area_x100`, `paid_area_x100`, `price_per_m2_minor` и массив `links` с парами `unit_id` / `deal_id`. Площади передаются в сотых долях м², цена за м² в центах USD. Ошибки валидации возвращают HTTP 400. Конфликты DB, включая `DIFFERENT_BUYERS` и `ALREADY_LINKED`, возвращают HTTP 409.

Поиск по всем доступным договорам через специализированный API, привязка ПКО и РКО, документы, денежные расчёты и слияние клиентов входят в оставшуюся реализацию.
