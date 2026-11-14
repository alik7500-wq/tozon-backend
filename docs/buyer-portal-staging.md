# Тестовый сервер кабинета покупателя

14.11.2026. Сервис создан с разрешения пользователя, только для теста. Рабочая CRM и webhook действующего бота не менялись.

- Workspace: Акмалхон's workspace (`tea-da2pspoae00c73cmljg0`).
- Service: `tozon-buyer-test-api`, ID `srv-dbs52b6i0phs73c4td20`.
- Dashboard: https://dashboard.render.com/web/srv-dbs52b6i0phs73c4td20
- API: https://tozon-buyer-test-api.onrender.com
- Git: `feature/buyer-portal`, auto-deploy выключен, runtime Node, бесплатный plan, Frankfurt.
- Тестовая Supabase: `tozon-crm-commercial-test`, ref `yaolkwbnhnacxxjpgiyu`; production ref не используется.
- Предназначенный бот по указанию пользователя: `@SavorCarBot`.

## Фактическое состояние

Первый deploy и повторный deploy настроек стали live; GET /api/health вернул status=ok. Это подтверждает запуск API-процесса, а не готовность buyer/SMS/данных. При проверке configured=false/running=false для бота.

Публичный test Supabase key установлен только для запуска подключения. Серверные buyer-операции требуют отдельного service_role ключа именно тестового проекта; он ещё не установлен. JWT_SECRET и BUYER_OTP_SECRET сгенерированы отдельно и сохранены только в Render. Настоящий токен бота не установлен: две OCR-версии изображения дали 401, точный токен должен быть введён непосредственно в Render. Временные локальные копии неверно считанного секрета удалены. Секретов в репозитории/отчёте нет.

BUYER_PORTAL_ENABLED=false, BUYER_NOTIFICATIONS_ENABLED=false; PAYOM_MOCK_MODE=true блокирует реальные SMS (в production runtime провайдер завершает их ошибкой, а не подтверждает mock). Рабочий бот не перенаправлялся, клиентские сообщения не отправлялись. Buyer-миграции в public тестовой базы в этом этапе не применялись; staging пока не пригоден для телефонной приёмки.

## Поддержка другого имени бота

Существующая проверка имени по умолчанию сохранена: TozonFinanceBot. Для тестового сервера используется явная TELEGRAM_FINANCE_BOT_USERNAME=SavorCarBot. Для любого другого имени требуется явный HTTPS TELEGRAM_FINANCE_WEBHOOK_URL; production webhook не наследуется по умолчанию. Чужой существующий webhook по-прежнему блокирует запуск, а не перезаписывается.

В Render уже задан тестовый webhook:
`https://tozon-buyer-test-api.onrender.com/api/telegram-finance/webhook`.

## Осталось настроить

В Environment именно этого нового сервиса, не рабочего backend:

1. TELEGRAM_FINANCE_BOT_TOKEN — точное значение из BotFather для SavorCarBot.
2. SUPABASE_SERVICE_ROLE_KEY — серверный ключ тестового Supabase проекта. SUPABASE_KEY также должен использовать соответствующий серверный доступ для служебной авторизации CRM; не копировать production credentials.
3. После подготовки отдельного тестового frontend: BUYER_PORTAL_URL, разрешённый origin CORS и затем buyer-флаги. До этого бот не подключать к пользователям.
4. Проверить совместимость тестовой схемы, применить 7 buyer-миграций в согласованном тестовом окружении, создать синтетический договор/тестового сотрудника без настоящих финансовых данных.
5. Реальный SMS: PAYOM_API_TOKEN, PAYOM_MOCK_MODE=false, разрешённый исходящий IP этого сервиса у Payom и согласованный тестовый телефон. Mock не может подтвердить покупателя.
6. Только после проверки getMe/тестового webhook включить buyer flow; автоматические уведомления включать отдельно для тестовых получателей.

После каждого изменения секретов требуется deploy. Auto-deploy выключен: обновление ветки само по себе не меняет сервис. Ключи в чат/исходники/логи не помещать. Приёмка на телефоне остаётся по docs/buyer-portal-acceptance.md.

Проверка изменения имени: 237 тестов buyer-portal/telegram-finance в 26 файлах успешны; node --check и diff --check успешны. Проверены прежний запрет чужого имени, явное подключение тестового имени только к своему URL и сохранение запрета перезаписывать конфликтующий webhook.
