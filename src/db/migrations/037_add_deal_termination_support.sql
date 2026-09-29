-- Migration: 037_add_deal_termination_support.sql (V2 Hardened)
-- Description: Adds deal termination financial columns, deal_id to expenses,
--              updates schedule status check constraint, and creates hardened atomic RPC function terminate_deal_atomic.

BEGIN;

-- 1. Add termination financial tracking columns to deals table
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS paid_at_termination_minor BIGINT DEFAULT 0;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS refund_amount_minor BIGINT DEFAULT 0;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS retained_amount_minor BIGINT DEFAULT 0;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS refund_expense_id BIGINT REFERENCES public.expenses(id) ON DELETE SET NULL;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS terminated_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL;

-- 2. Add deal_id column to expenses table for explicit relation
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS deal_id BIGINT REFERENCES public.deals(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_deal_id ON public.expenses(deal_id);

-- 3. Update deal_payment_schedules status check constraint to include CANCELLED
ALTER TABLE public.deal_payment_schedules DROP CONSTRAINT IF EXISTS deal_payment_schedules_status_check;
ALTER TABLE public.deal_payment_schedules ADD CONSTRAINT deal_payment_schedules_status_check 
CHECK (status IN ('UPCOMING', 'DUE', 'PARTIAL', 'PAID', 'OVERDUE', 'CANCELLED'));

-- 4. Create Hardened Atomic RPC Function for Single-Transaction Termination
CREATE OR REPLACE FUNCTION public.terminate_deal_atomic(
    p_deal_id BIGINT,
    p_user_id BIGINT,
    p_reason TEXT,
    p_comment TEXT DEFAULT NULL,
    p_refund_amount_minor BIGINT DEFAULT 0,
    p_retention_reason TEXT DEFAULT NULL,
    p_cash_desk_id UUID DEFAULT NULL,
    p_idempotency_key TEXT DEFAULT NULL,
    p_effective_date TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_deal RECORD;
    v_paid_total_minor BIGINT := 0;
    v_retained_amount_minor BIGINT := 0;
    v_refund_expense_id BIGINT := NULL;
    v_cash_desk_exists BOOLEAN := FALSE;
    v_effective_date TEXT;
    v_idempotency_key TEXT;
    v_contract_num TEXT;
    v_updated_deal JSONB;
BEGIN
    -- A. Lock and fetch existing deal (Row-level lock FOR UPDATE)
    SELECT * INTO v_deal FROM public.deals WHERE id = p_deal_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DEAL_NOT_FOUND: Сделка не найдена' USING ERRCODE = 'P0002';
    END IF;

    -- Concurrency guard: Re-read status after acquiring lock
    IF v_deal.status = 'CANCELLED' THEN
        RAISE EXCEPTION 'DEAL_ALREADY_CANCELLED: Сделка уже расторгнута / отменена' USING ERRCODE = 'P0003';
    END IF;

    -- Lock associated unit
    PERFORM 1 FROM public.units WHERE id = v_deal.unit_id FOR UPDATE;

    -- B. Compute actual paid total from active payments in DB (Source of Truth)
    SELECT COALESCE(SUM(amount_minor), 0) INTO v_paid_total_minor 
    FROM public.payments 
    WHERE deal_id = p_deal_id AND status <> 'VOIDED';

    -- C. Validate reason
    IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
        RAISE EXCEPTION 'TERMINATION_REASON_REQUIRED: Причина расторжения договора обязательна' USING ERRCODE = 'P0004';
    END IF;

    -- D. Validate refund & retention invariants
    IF p_refund_amount_minor < 0 THEN
        RAISE EXCEPTION 'INVALID_REFUND_AMOUNT: Сумма возврата не может быть отрицательной' USING ERRCODE = 'P0005';
    END IF;

    IF v_paid_total_minor = 0 THEN
        IF p_refund_amount_minor > 0 THEN
            RAISE EXCEPTION 'REFUND_NOT_ALLOWED_ZERO_PAID: По данной сделке нет фактических платежей. Сумма возврата должна быть 0' USING ERRCODE = 'P0006';
        END IF;
    ELSE
        IF p_refund_amount_minor > v_paid_total_minor THEN
            RAISE EXCEPTION 'REFUND_EXCEEDS_PAID: Сумма возврата не может превышать фактически полученную сумму' USING ERRCODE = 'P0007';
        END IF;
    END IF;

    v_retained_amount_minor := v_paid_total_minor - p_refund_amount_minor;

    IF v_retained_amount_minor > 0 AND (p_retention_reason IS NULL OR TRIM(p_retention_reason) = '') THEN
        RAISE EXCEPTION 'RETENTION_REASON_REQUIRED: При наличии удержания необходимо указать основание удержания' USING ERRCODE = 'P0008';
    END IF;

    -- E. Validate Cash Desk if refund > 0
    IF p_refund_amount_minor > 0 THEN
        IF p_cash_desk_id IS NULL THEN
            RAISE EXCEPTION 'CASH_DESK_REQUIRED: Касса списания обязательна при возврате средств' USING ERRCODE = 'P0009';
        END IF;

        SELECT EXISTS (
            SELECT 1 FROM public.dictionaries WHERE id = p_cash_desk_id AND type = 'CASH_DESK' AND is_active = true
        ) INTO v_cash_desk_exists;

        IF NOT v_cash_desk_exists THEN
            RAISE EXCEPTION 'INVALID_CASH_DESK: Указанная касса списания не найдена или неактивна' USING ERRCODE = 'P0010';
        END IF;
    END IF;

    -- F. Deterministic Idempotency Key (Guarantees DB-level UNIQUE protection)
    v_idempotency_key := COALESCE(NULLIF(TRIM(p_idempotency_key), ''), 'TERMINATE_DEAL_' || p_deal_id::TEXT);
    v_effective_date := COALESCE(NULLIF(TRIM(p_effective_date), ''), CURRENT_DATE::TEXT);
    v_contract_num := COALESCE(v_deal.contract_number, p_deal_id::TEXT);

    -- G. Insert Refund RKO if refund > 0 (Guarded by DB-level UNIQUE constraint on idempotency_key)
    IF p_refund_amount_minor > 0 THEN
        -- Check if already inserted via idempotency key
        SELECT id INTO v_refund_expense_id 
        FROM public.expenses 
        WHERE idempotency_key = v_idempotency_key;

        IF v_refund_expense_id IS NULL THEN
            INSERT INTO public.expenses (
                category,
                amount_minor,
                currency,
                expense_date,
                recipient,
                description,
                reference,
                cash_desk_id,
                idempotency_key,
                created_by_user_id,
                deal_id,
                status,
                created_at
            ) VALUES (
                'Возврат средств (расторжение договора)',
                p_refund_amount_minor,
                v_deal.currency,
                v_effective_date,
                'Клиент по дог. №' || v_contract_num,
                TRIM('Возврат денежных средств при расторжении договора №' || v_contract_num || '. ' || COALESCE(p_comment, '')),
                'РКО-ВОЗВРАТ-' || v_contract_num,
                p_cash_desk_id,
                v_idempotency_key,
                p_user_id,
                p_deal_id,
                'ACTIVE',
                NOW()
            )
            RETURNING id INTO v_refund_expense_id;
        END IF;
    END IF;

    -- H. Update Deal state to CANCELLED and store termination metadata
    UPDATE public.deals
    SET
        status = 'CANCELLED',
        cancelled_at = NOW(),
        cancellation_reason = p_reason,
        paid_at_termination_minor = v_paid_total_minor,
        refund_amount_minor = p_refund_amount_minor,
        retained_amount_minor = v_retained_amount_minor,
        refund_expense_id = v_refund_expense_id,
        terminated_by_user_id = p_user_id,
        updated_at = NOW()
    WHERE id = p_deal_id;

    -- I. Update Unit state to AVAILABLE
    UPDATE public.units
    SET
        status = 'AVAILABLE',
        updated_at = NOW()
    WHERE id = v_deal.unit_id;

    -- J. Update deal_payment_schedules preserving historical plan & paid amounts
    --    Unpaid / future obligations transition to CANCELLED.
    --    PARTIAL schedules keep original amount_minor (planned) and paid_amount_minor (paid fact).
    UPDATE public.deal_payment_schedules
    SET
        status = 'CANCELLED',
        updated_at = NOW()
    WHERE deal_id = p_deal_id 
      AND status NOT IN ('PAID');

    -- K. Log Audit Trail Entry
    INSERT INTO public.deal_audit_logs (
        deal_id,
        user_id,
        action,
        changes_json,
        created_at
    ) VALUES (
        p_deal_id,
        p_user_id,
        'TERMINATE_DEAL',
        jsonb_build_object(
            'contract_number', v_deal.contract_number,
            'unit_id', v_deal.unit_id,
            'lead_id', v_deal.lead_id,
            'currency', v_deal.currency,
            'contract_total_minor', v_deal.final_price_minor,
            'paid_total_minor', v_paid_total_minor,
            'refund_amount_minor', p_refund_amount_minor,
            'retained_amount_minor', v_retained_amount_minor,
            'refund_expense_id', v_refund_expense_id,
            'cash_desk_id', p_cash_desk_id,
            'reason', p_reason,
            'retention_reason', p_retention_reason,
            'comment', p_comment,
            'idempotency_key', v_idempotency_key
        ),
        NOW()
    );

    SELECT to_jsonb(d.*) INTO v_updated_deal FROM public.deals d WHERE d.id = p_deal_id;
    RETURN v_updated_deal;
END;
$$;

-- 5. Strict Execution Permission Hardening: Block direct client bypass via PostgREST
REVOKE ALL ON FUNCTION public.terminate_deal_atomic(BIGINT, BIGINT, TEXT, TEXT, BIGINT, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.terminate_deal_atomic(BIGINT, BIGINT, TEXT, TEXT, BIGINT, TEXT, UUID, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.terminate_deal_atomic(BIGINT, BIGINT, TEXT, TEXT, BIGINT, TEXT, UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.terminate_deal_atomic(BIGINT, BIGINT, TEXT, TEXT, BIGINT, TEXT, UUID, TEXT, TEXT) TO service_role;

COMMIT;
