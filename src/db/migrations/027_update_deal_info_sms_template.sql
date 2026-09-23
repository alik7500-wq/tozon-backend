-- Migration 027: Update DEAL_INFO template with context-aware financial and area placeholders

UPDATE sms_templates
SET 
    text = '{{client_name}}: дог. №{{contract_number}}, кв. №{{apartment}} ({{apartment_area}} м²). Стоимость {{contract_total}} {{currency}}, оплачено {{total_paid}} {{currency}}, остаток {{remaining_balance}} {{currency}}. TOZON-PLAZA',
    updated_at = NOW()
WHERE code = 'DEAL_INFO';
