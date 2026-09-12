-- Migration: 020_add_deal_audit_log_and_atomic_update.sql
-- Description: Create deal_audit_logs table and atomic RPC function update_deal_atomic 
--              enforcing paid deal financial protection, schedule recalculation, and audit logging.

BEGIN;

CREATE TABLE IF NOT EXISTS deal_audit_logs (
    id BIGSERIAL PRIMARY KEY,
    deal_id BIGINT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL,
    changes_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION update_deal_atomic(
    p_deal_id BIGINT,
    p_user_id BIGINT,
    p_updates_json JSONB,
    p_lead_updates_json JSONB DEFAULT NULL,
    p_schedules_json JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_deal RECORD;
    v_payments_count INT;
    v_has_financial_keys BOOLEAN := FALSE;
    v_key TEXT;
    v_old_deal JSONB;
    v_new_deal JSONB;
BEGIN
    -- 1. Lock and fetch existing deal
    SELECT * INTO v_deal FROM deals WHERE id = p_deal_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DEAL_NOT_FOUND: Сделка не найдена' USING ERRCODE = 'P0002';
    END IF;

    v_old_deal := to_jsonb(v_deal);

    -- 2. Check if payments exist
    SELECT COUNT(*) INTO v_payments_count FROM payments WHERE deal_id = p_deal_id;

    -- 3. Check financial keys presence in updates
    IF v_payments_count > 0 THEN
        FOR v_key IN SELECT jsonb_object_keys(p_updates_json)
        LOOP
            IF v_key IN ('base_price_minor', 'discount_minor', 'final_price_minor', 'deal_price_per_m2_minor', 'down_payment_minor', 'installment_months', 'exchange_rate', 'payment_type') THEN
                v_has_financial_keys := TRUE;
                EXIT;
            END IF;
        END LOOP;

        IF v_has_financial_keys THEN
            RAISE EXCEPTION 'PAID_DEAL_FINANCIAL_EDIT_BLOCKED: Запрещено изменять финансовые условия сделки, по которой уже проведены фактические платежи' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    -- 4. Dynamic update of deals table fields from p_updates_json
    UPDATE deals
    SET
        deal_date = COALESCE((p_updates_json->>'deal_date'), deal_date),
        contract_number = COALESCE((p_updates_json->>'contract_number'), contract_number),
        responsible_user_id = CASE 
            WHEN p_updates_json ? 'responsible_user_id' THEN (p_updates_json->>'responsible_user_id')::BIGINT 
            ELSE responsible_user_id 
        END,
        reservation_expires_at = CASE 
            WHEN p_updates_json ? 'reservation_expires_at' THEN (p_updates_json->>'reservation_expires_at') 
            ELSE reservation_expires_at 
        END,
        payment_type = COALESCE((p_updates_json->>'payment_type'), payment_type),
        installment_months = COALESCE((p_updates_json->>'installment_months')::INT, installment_months),
        barter_description = CASE 
            WHEN p_updates_json ? 'barter_description' THEN (p_updates_json->>'barter_description') 
            ELSE barter_description 
        END,
        barter_amount_minor = COALESCE((p_updates_json->>'barter_amount_minor')::BIGINT, barter_amount_minor),
        base_price_minor = COALESCE((p_updates_json->>'base_price_minor')::BIGINT, base_price_minor),
        discount_minor = COALESCE((p_updates_json->>'discount_minor')::BIGINT, discount_minor),
        final_price_minor = COALESCE((p_updates_json->>'final_price_minor')::BIGINT, final_price_minor),
        deal_price_per_m2_minor = COALESCE((p_updates_json->>'deal_price_per_m2_minor')::BIGINT, deal_price_per_m2_minor),
        down_payment_minor = COALESCE((p_updates_json->>'down_payment_minor')::BIGINT, down_payment_minor),
        exchange_rate = COALESCE((p_updates_json->>'exchange_rate')::NUMERIC, exchange_rate),
        updated_at = NOW()
    WHERE id = p_deal_id;

    -- 5. Update lead/buyer details if provided
    IF p_lead_updates_json IS NOT NULL AND jsonb_typeof(p_lead_updates_json) = 'object' THEN
        UPDATE leads
        SET
            full_name = COALESCE((p_lead_updates_json->>'full_name'), full_name),
            phone = COALESCE((p_lead_updates_json->>'phone'), phone),
            passport_series = CASE WHEN p_lead_updates_json ? 'passport_series' THEN (p_lead_updates_json->>'passport_series') ELSE passport_series END,
            passport_number = CASE WHEN p_lead_updates_json ? 'passport_number' THEN (p_lead_updates_json->>'passport_number') ELSE passport_number END,
            inn = CASE WHEN p_lead_updates_json ? 'inn' THEN (p_lead_updates_json->>'inn') ELSE inn END,
            updated_at = NOW()
        WHERE id = v_deal.lead_id;
    END IF;

    -- 6. Recalculate or replace schedules if p_schedules_json provided
    IF p_schedules_json IS NOT NULL AND jsonb_typeof(p_schedules_json) = 'array' THEN
        DELETE FROM deal_payment_schedules WHERE deal_id = p_deal_id;

        IF jsonb_array_length(p_schedules_json) > 0 THEN
            INSERT INTO deal_payment_schedules (
                deal_id, payment_number, due_date, amount_minor, paid_amount_minor, status, created_at, updated_at
            )
            SELECT 
                p_deal_id,
                (elem->>'payment_number')::INT,
                (elem->>'due_date'),
                (elem->>'amount_minor')::BIGINT,
                COALESCE((elem->>'paid_amount_minor')::BIGINT, 0),
                COALESCE((elem->>'status'), 'UPCOMING'),
                NOW(),
                NOW()
            FROM jsonb_array_elements(p_schedules_json) AS elem;
        END IF;
    END IF;

    -- 7. Log audit record
    INSERT INTO deal_audit_logs (deal_id, user_id, action, changes_json, created_at)
    VALUES (
        p_deal_id,
        p_user_id,
        'UPDATE_DEAL',
        jsonb_build_object('old', v_old_deal, 'updates', p_updates_json),
        NOW()
    );

    SELECT to_jsonb(d.*) INTO v_new_deal FROM deals d WHERE d.id = p_deal_id;
    RETURN v_new_deal;
END;
$$;

COMMIT;
