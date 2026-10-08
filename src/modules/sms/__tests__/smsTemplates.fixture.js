export const smsTemplateFixtures = [
  {
    id: 1,
    code: "CLIENT_WELCOME",
    name: "Приветствие клиента",
    text: "Здравствуйте, {{client_name}}! Спасибо за обращение в отдел продаж ЖК TOZON-PLAZA.",
    is_active: true,
  },
  {
    id: 2,
    code: "MEETING_REMINDER",
    name: "Напоминание о встрече",
    text: "Здравствуйте, {{client_name}}! Напоминаем о запланированной встрече {{meeting_date}} в {{meeting_time}}. TOZON-PLAZA.",
    is_active: true,
  },
  {
    id: 3,
    code: "DEAL_INFO",
    name: "Сообщение по договору",
    text: "{{client_name}}: дог. №{{contract_number}}, кв. №{{apartment}} ({{apartment_area}} м²). Стоимость {{contract_total}} {{currency}}, оплачено {{total_paid}} {{currency}}, остаток {{remaining_balance}} {{currency}}. {{project_name}}",
    is_active: true,
  },
  {
    id: 4,
    code: "PAYMENT_REMINDER",
    name: "Напоминание об оплате",
    text: "Здравствуйте, {{client_name}}! Напоминаем об очередной оплате по договору №{{contract_number}} в размере {{payment_amount}} {{currency}} до {{payment_date}}. TOZON-PLAZA.",
    is_active: true,
  },
  {
    id: 5,
    code: "DEBTOR_REMINDER",
    name: "Напоминание о задолженности",
    text: "Уважаемый(ая) {{client_name}}! Просим внести просроченную оплату {{overdue_amount}} {{currency}} по договору №{{contract_number}}. TOZON-PLAZA.",
    is_active: true,
  },
  {
    id: 6,
    code: "PAYMENT_RECEIVED",
    name: "Подтверждение оплаты",
    text: "Уважаемый(ая) {{client_name}}! Оплата по договору №{{contract_number}} на сумму {{payment_amount}} {{payment_currency}} принята. Всего оплачено {{total_paid}} {{contract_currency}}. Остаток по договору: {{remaining_balance}} {{contract_currency}}. Спасибо! TOZON-PLAZA.",
    is_active: true,
  },
];
