-- Migration 028: Add payment_id to sms_messages table and seed PAYMENT_RECEIVED template

ALTER TABLE sms_messages
ADD COLUMN IF NOT EXISTS payment_id INT REFERENCES payments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sms_messages_payment_id ON sms_messages(payment_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_messages_unique_payment_sent 
ON sms_messages(payment_id) 
WHERE payment_id IS NOT NULL AND status IN ('queued', 'sending', 'sent', 'delivered');

INSERT INTO sms_templates (code, name, text, is_active)
VALUES
    ('PAYMENT_RECEIVED', 'Подтверждение оплаты', 'Уважаемый(ая) {{client_name}}! Оплата по договору №{{contract_number}} на сумму {{payment_amount}} {{payment_currency}} принята. Всего оплачено {{total_paid}} {{contract_currency}}. Остаток по договору: {{remaining_balance}} {{contract_currency}}. Спасибо! TOZON-PLAZA.', TRUE)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    text = EXCLUDED.text,
    is_active = EXCLUDED.is_active;
