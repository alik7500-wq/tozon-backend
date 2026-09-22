-- Migration 025: SMS Integration Schema (sms_messages and sms_templates)

CREATE TABLE IF NOT EXISTS sms_messages (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_id BIGINT REFERENCES leads(id) ON DELETE SET NULL,
    deal_id BIGINT REFERENCES deals(id) ON DELETE SET NULL,
    contract_id BIGINT,
    phone TEXT NOT NULL,
    message TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'PAYOM',
    sender_name TEXT NOT NULL DEFAULT 'TOZON-PLAZA',
    provider_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'sending', 'sent', 'delivered', 'failed')),
    error_code TEXT,
    error_message TEXT,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_messages_client_id ON sms_messages(client_id);
CREATE INDEX IF NOT EXISTS idx_sms_messages_phone ON sms_messages(phone);
CREATE INDEX IF NOT EXISTS idx_sms_messages_status ON sms_messages(status);
CREATE INDEX IF NOT EXISTS idx_sms_messages_created_at ON sms_messages(created_at DESC);

CREATE TABLE IF NOT EXISTS sms_templates (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed basic default SMS templates
INSERT INTO sms_templates (code, name, text, is_active)
VALUES
    ('CLIENT_WELCOME', 'Приветствие клиента', 'Уважаемый(ая) {{client_name}}, спасибо за обращение в отдел продаж ЖК TOZON-PLAZA!', TRUE),
    ('MEETING_REMINDER', 'Напоминание о встрече', 'Здравствуйте, {{client_name}}! Напоминаем о запланированной встрече в офисе TOZON-PLAZA.', TRUE),
    ('CUSTOM_MESSAGE', 'Произвольное сообщение', '{{text}}', TRUE)
ON CONFLICT (code) DO NOTHING;
