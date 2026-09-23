-- Migration 026: Update SMS templates with context-aware placeholders, codes, and currency

INSERT INTO sms_templates (code, name, text, is_active)
VALUES
    ('CLIENT_WELCOME', 'Приветствие клиента', 'Здравствуйте, {{client_name}}! Спасибо за обращение в отдел продаж ЖК TOZON-PLAZA.', TRUE),
    ('MEETING_REMINDER', 'Напоминание о встрече', 'Здравствуйте, {{client_name}}! Напоминаем о запланированной встрече {{meeting_date}} в {{meeting_time}}. TOZON-PLAZA.', TRUE),
    ('DEAL_INFO', 'Сообщение по договору', 'Здравствуйте, {{client_name}}! Информация по вашему договору №{{contract_number}} (кв. №{{apartment}}, {{project_name}}). TOZON-PLAZA.', TRUE),
    ('PAYMENT_REMINDER', 'Напоминание об оплате', 'Здравствуйте, {{client_name}}! Напоминаем об очередной оплате по договору №{{contract_number}} в размере {{payment_amount}} {{currency}} до {{payment_date}}. TOZON-PLAZA.', TRUE),
    ('DEBTOR_REMINDER', 'Напоминание о задолженности', 'Уважаемый(ая) {{client_name}}! Просим внести просроченную оплату {{overdue_amount}} {{currency}} по договору №{{contract_number}}. TOZON-PLAZA.', TRUE)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    text = EXCLUDED.text,
    is_active = EXCLUDED.is_active;

-- Deactivate old literal CUSTOM_MESSAGE template from DB so API never returns {{text}}
UPDATE sms_templates SET is_active = FALSE WHERE code = 'CUSTOM_MESSAGE';
