-- =============================================================================
-- Migration: 057_marketing_commission_atomic_ops_and_rko_guard.sql
-- Purpose:
--   1. Create `public.marketing_commission_operations` for PostgreSQL-level
--      idempotency, replay, conflict detection, and 1-to-1 RKO linkage.
--   2. Create atomic PostgreSQL RPCs with `SELECT ... FOR UPDATE` row locks:
--      - `approve_marketing_commission_atomic`
--      - `record_marketing_commission_payout_atomic`
--   3. Create trigger `trg_guard_void_rko_linked_commission` on `public.expenses`
--      so voiding an RKO automatically reverses the linked commission payout.
-- NOTE: Do NOT run on production without explicit owner approval.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.marketing_commission_operations (
  id BIGSERIAL PRIMARY KEY,
  deal_id BIGINT NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('APPROVE', 'RECORD_PAYOUT', 'CANCEL')),
  amount_minor BIGINT NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  rko_expense_id BIGINT UNIQUE REFERENCES public.expenses(id) ON DELETE RESTRICT,
  rko_reference TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  response_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  created_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_at TIMESTAMPTZ,
  void_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_marketing_comm_ops_deal_id
  ON public.marketing_commission_operations(deal_id, created_at DESC);

ALTER TABLE public.marketing_commission_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketing_commission_operations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.marketing_commission_operations_id_seq FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.marketing_commission_operations TO service_role, postgres;
GRANT USAGE, SELECT ON SEQUENCE public.marketing_commission_operations_id_seq TO service_role, postgres;

DROP POLICY IF EXISTS marketing_commission_operations_service_role ON public.marketing_commission_operations;
CREATE POLICY marketing_commission_operations_service_role ON public.marketing_commission_operations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =============================================================================
-- Atomic APPROVE RPC (with PostgreSQL FOR UPDATE lock & idempotency)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.approve_marketing_commission_atomic(
  p_deal_id BIGINT,
  p_actor_id BIGINT,
  p_approved_minor BIGINT,
  p_calculated_minor BIGINT,
  p_rate_bp INTEGER,
  p_partner_id BIGINT,
  p_contract_price_minor BIGINT,
  p_idempotency_key TEXT,
  p_notes TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_key TEXT := NULLIF(TRIM(COALESCE(p_idempotency_key, '')), '');
  v_fingerprint TEXT;
  v_existing_op RECORD;
  v_deal RECORD;
  v_comm RECORD;
  v_additional_minor BIGINT;
  v_new_status TEXT;
  v_now TIMESTAMPTZ := NOW();
  v_snapshot JSONB;
BEGIN
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: Параметр idempotency_key обязателен';
  END IF;

  v_fingerprint := p_deal_id::TEXT || '|APPROVE|' || COALESCE(p_approved_minor, 0)::TEXT;

  SELECT * INTO v_existing_op
  FROM public.marketing_commission_operations
  WHERE idempotency_key = v_key;

  IF FOUND THEN
    IF v_existing_op.request_fingerprint = v_fingerprint THEN
      RETURN v_existing_op.response_snapshot || jsonb_build_object('idempotent', TRUE);
    ELSE
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: Ключ идемпотентности % уже использован с другими параметрами', v_key;
    END IF;
  END IF;

  SELECT * INTO v_deal
  FROM public.deals
  WHERE id = p_deal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DEAL_NOT_FOUND: Сделка % не найдена', p_deal_id;
  END IF;

  IF UPPER(COALESCE(v_deal.status, '')) = 'CANCELLED' OR v_deal.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'DEAL_CANCELLED: Невозможно утвердить комиссию по расторгнутому договору';
  END IF;

  IF UPPER(COALESCE(v_deal.status, '')) <> 'SIGNED' THEN
    RAISE EXCEPTION 'DEAL_NOT_SIGNED: Комиссия утверждается только по подписанному договору';
  END IF;

  IF UPPER(COALESCE(v_deal.sales_source, 'UNSPECIFIED')) <> 'MARKETER' THEN
    RAISE EXCEPTION 'COMMISSION_NOT_ALLOWED_FOR_SOURCE: Комиссия разрешена только для MARKETER';
  END IF;

  IF COALESCE(p_approved_minor, 0) <= 0 THEN
    RAISE EXCEPTION 'APPROVED_COMMISSION_MUST_BE_POSITIVE: Сумма утверждения должна быть > 0';
  END IF;

  SELECT * INTO v_comm
  FROM public.marketing_commissions
  WHERE deal_id = p_deal_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_comm.status = 'CANCELLED' THEN
      RAISE EXCEPTION 'COMMISSION_CANCELLED: Нельзя утвердить отменённую комиссию';
    END IF;
    IF p_approved_minor < v_comm.paid_amount_minor THEN
      RAISE EXCEPTION 'APPROVED_BELOW_PAID: Утверждённая сумма меньше уже выплаченной';
    END IF;
    IF v_comm.status IN ('APPROVED', 'PARTIALLY_PAID', 'PAID') AND p_approved_minor <= v_comm.approved_amount_minor THEN
      RAISE EXCEPTION 'COMMISSION_ALREADY_APPROVED: Комиссия по данному договору уже утверждена';
    END IF;
    v_additional_minor := GREATEST(0, p_approved_minor - v_comm.approved_amount_minor);
    v_new_status := CASE
      WHEN v_comm.paid_amount_minor >= p_approved_minor THEN 'PAID'
      WHEN v_comm.paid_amount_minor > 0 THEN 'PARTIALLY_PAID'
      ELSE 'APPROVED'
    END;

    UPDATE public.marketing_commissions
    SET partner_id = COALESCE(p_partner_id, partner_id),
        contract_price_minor = COALESCE(p_contract_price_minor, contract_price_minor),
        commission_type = CASE WHEN COALESCE(p_rate_bp, 0) > 0 THEN 'PERCENT' ELSE commission_type END,
        commission_rate_bp = COALESCE(p_rate_bp, commission_rate_bp),
        calculated_amount_minor = GREATEST(COALESCE(p_calculated_minor, 0), p_approved_minor),
        approved_amount_minor = p_approved_minor,
        status = v_new_status,
        approved_at = v_now,
        approved_by = p_actor_id,
        notes = NULLIF(TRIM(COALESCE(p_notes, '')), ''),
        updated_at = v_now
    WHERE deal_id = p_deal_id;
  ELSE
    v_additional_minor := p_approved_minor;
    v_new_status := 'APPROVED';
    INSERT INTO public.marketing_commissions (
      deal_id, partner_id, contract_price_minor, commission_type, commission_rate_bp,
      calculated_amount_minor, approved_amount_minor, paid_amount_minor, status,
      accrued_at, approved_at, approved_by, notes, updated_at
    ) VALUES (
      p_deal_id, p_partner_id, COALESCE(p_contract_price_minor, 0),
      CASE WHEN COALESCE(p_rate_bp, 0) > 0 THEN 'PERCENT' ELSE 'NONE' END,
      COALESCE(p_rate_bp, 0),
      GREATEST(COALESCE(p_calculated_minor, 0), p_approved_minor),
      p_approved_minor, 0, v_new_status,
      v_now, v_now, p_actor_id, NULLIF(TRIM(COALESCE(p_notes, '')), ''), v_now
    );
  END IF;

  v_snapshot := jsonb_build_object(
    'deal_id', p_deal_id,
    'action_type', 'APPROVE',
    'approved_amount_minor', p_approved_minor,
    'additional_accrual_minor', v_additional_minor,
    'status', v_new_status,
    'approved_at', v_now,
    'idempotent', FALSE
  );

  INSERT INTO public.marketing_commission_operations (
    deal_id, action_type, amount_minor, idempotency_key,
    request_fingerprint, response_snapshot, notes, created_by
  ) VALUES (
    p_deal_id, 'APPROVE', v_additional_minor, v_key,
    v_fingerprint, v_snapshot, p_notes, p_actor_id
  );

  INSERT INTO public.deal_audit_logs (deal_id, user_id, action, changes_json)
  VALUES (
    p_deal_id,
    p_actor_id,
    'UPDATE_COMMISSION_STATUS',
    jsonb_build_object(
      'action_type', 'APPROVE',
      'approved_amount_minor', p_approved_minor,
      'additional_accrual_minor', v_additional_minor,
      'status', v_new_status,
      'approved_at', v_now,
      'approved_by', p_actor_id,
      'idempotency_key', v_key,
      'notes', COALESCE(p_notes, '')
    )
  );

  RETURN v_snapshot;
END;
$$;

-- =============================================================================
-- Atomic RECORD_PAYOUT RPC (with PostgreSQL FOR UPDATE lock, idempotency & RKO guard)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.record_marketing_commission_payout_atomic(
  p_deal_id BIGINT,
  p_actor_id BIGINT,
  p_payout_minor BIGINT,
  p_rko_expense_id BIGINT,
  p_expected_partner_name TEXT,
  p_idempotency_key TEXT,
  p_notes TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_key TEXT := NULLIF(TRIM(COALESCE(p_idempotency_key, '')), '');
  v_fingerprint TEXT;
  v_existing_op RECORD;
  v_deal RECORD;
  v_comm RECORD;
  v_rko RECORD;
  v_next_paid_minor BIGINT;
  v_next_status TEXT;
  v_rko_ref TEXT;
  v_now TIMESTAMPTZ := NOW();
  v_snapshot JSONB;
BEGIN
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: Параметр idempotency_key обязателен';
  END IF;

  IF p_rko_expense_id IS NULL THEN
    RAISE EXCEPTION 'RKO_REQUIRED: Для регистрации выплаты требуется привязка к проведённому РКО';
  END IF;

  v_fingerprint := p_deal_id::TEXT || '|RECORD_PAYOUT|' || COALESCE(p_payout_minor, 0)::TEXT || '|' || p_rko_expense_id::TEXT;

  SELECT * INTO v_existing_op
  FROM public.marketing_commission_operations
  WHERE idempotency_key = v_key;

  IF FOUND THEN
    IF v_existing_op.request_fingerprint = v_fingerprint THEN
      RETURN v_existing_op.response_snapshot || jsonb_build_object('idempotent', TRUE);
    ELSE
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: Ключ идемпотентности % уже использован с другими параметрами', v_key;
    END IF;
  END IF;

  IF COALESCE(p_payout_minor, 0) <= 0 THEN
    RAISE EXCEPTION 'INVALID_PAYOUT_AMOUNT: Сумма выплаты должна быть > 0';
  END IF;

  SELECT * INTO v_deal
  FROM public.deals
  WHERE id = p_deal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DEAL_NOT_FOUND: Сделка % не найдена', p_deal_id;
  END IF;

  IF UPPER(COALESCE(v_deal.status, '')) = 'CANCELLED' OR v_deal.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'DEAL_CANCELLED: Выплата по расторгнутому договору запрещена';
  END IF;

  IF UPPER(COALESCE(v_deal.sales_source, 'UNSPECIFIED')) <> 'MARKETER' THEN
    RAISE EXCEPTION 'COMMISSION_NOT_ALLOWED_FOR_SOURCE: Выплата разрешена только для MARKETER';
  END IF;

  SELECT * INTO v_comm
  FROM public.marketing_commissions
  WHERE deal_id = p_deal_id
  FOR UPDATE;

  IF NOT FOUND OR v_comm.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'COMMISSION_CANCELLED_OR_MISSING: Выплата по отменённой или неутверждённой комиссии запрещена';
  END IF;

  IF v_comm.status NOT IN ('APPROVED', 'PARTIALLY_PAID') THEN
    RAISE EXCEPTION 'COMMISSION_NOT_APPROVED: Выплата возможна только по утверждённой комиссии';
  END IF;

  IF v_comm.paid_amount_minor > v_comm.calculated_amount_minor THEN
    RAISE EXCEPTION 'COMMISSION_OVERPAID: Зафиксирована переплата комиссии, новые выплаты заблокированы';
  END IF;

  v_next_paid_minor := v_comm.paid_amount_minor + p_payout_minor;
  IF v_next_paid_minor > v_comm.approved_amount_minor THEN
    RAISE EXCEPTION 'PAYOUT_EXCEEDS_APPROVED: Сумма выплаты превышает остаток утверждённой комиссии';
  END IF;

  -- Lock and validate linked RKO
  SELECT * INTO v_rko
  FROM public.expenses
  WHERE id = p_rko_expense_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RKO_NOT_FOUND: Документ РКО #% не найден', p_rko_expense_id;
  END IF;

  IF v_rko.voided_at IS NOT NULL OR UPPER(COALESCE(v_rko.status, 'ACTIVE')) IN ('VOIDED', 'CANCELLED', 'REVERSED') THEN
    RAISE EXCEPTION 'RKO_VOIDED: Нельзя привязать аннулированный РКО';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.marketing_commission_operations
    WHERE rko_expense_id = p_rko_expense_id AND voided_at IS NULL
  ) THEN
    RAISE EXCEPTION 'RKO_ALREADY_LINKED: Этот РКО уже привязан к другой выплате комиссии';
  END IF;

  IF COALESCE(v_rko.amount_minor, 0) <> p_payout_minor THEN
    RAISE EXCEPTION 'RKO_AMOUNT_MISMATCH: Сумма РКО (%) не совпадает с суммой выплаты (%)', v_rko.amount_minor, p_payout_minor;
  END IF;

  IF NULLIF(TRIM(COALESCE(p_expected_partner_name, '')), '') IS NOT NULL THEN
    IF LOWER(TRIM(COALESCE(v_rko.recipient, ''))) <> LOWER(TRIM(p_expected_partner_name)) THEN
      RAISE EXCEPTION 'RKO_RECIPIENT_MISMATCH: Получатель в РКО (%) не совпадает с партнёром (%)', v_rko.recipient, p_expected_partner_name;
    END IF;
  END IF;

  v_rko_ref := COALESCE(NULLIF(TRIM(v_rko.reference), ''), 'РКО-' || v_rko.id::TEXT);
  v_next_status := CASE WHEN v_next_paid_minor >= v_comm.approved_amount_minor THEN 'PAID' ELSE 'PARTIALLY_PAID' END;

  UPDATE public.marketing_commissions
  SET paid_amount_minor = v_next_paid_minor,
      status = v_next_status,
      paid_at = v_now,
      updated_at = v_now
  WHERE deal_id = p_deal_id;

  v_snapshot := jsonb_build_object(
    'deal_id', p_deal_id,
    'action_type', 'RECORD_PAYOUT',
    'payout_delta_minor', p_payout_minor,
    'paid_amount_minor', v_next_paid_minor,
    'status', v_next_status,
    'rko_expense_id', p_rko_expense_id,
    'rko_reference', v_rko_ref,
    'paid_at', v_now,
    'idempotent', FALSE
  );

  INSERT INTO public.marketing_commission_operations (
    deal_id, action_type, amount_minor, rko_expense_id, rko_reference,
    idempotency_key, request_fingerprint, response_snapshot, notes, created_by
  ) VALUES (
    p_deal_id, 'RECORD_PAYOUT', p_payout_minor, p_rko_expense_id, v_rko_ref,
    v_key, v_fingerprint, v_snapshot, p_notes, p_actor_id
  );

  INSERT INTO public.deal_audit_logs (deal_id, user_id, action, changes_json)
  VALUES (
    p_deal_id,
    p_actor_id,
    'UPDATE_COMMISSION_STATUS',
    jsonb_build_object(
      'action_type', 'RECORD_PAYOUT',
      'payout_delta_minor', p_payout_minor,
      'paid_amount_minor', v_next_paid_minor,
      'status', v_next_status,
      'paid_at', v_now,
      'rko_expense_id', p_rko_expense_id,
      'rko_reference', v_rko_ref,
      'idempotency_key', v_key,
      'notes', COALESCE(p_notes, '')
    )
  );

  RETURN v_snapshot;
END;
$$;

-- =============================================================================
-- Trigger: If a linked RKO is voided, automatically reverse the commission payout
-- =============================================================================
CREATE OR REPLACE FUNCTION public.guard_void_rko_linked_commission()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_op RECORD;
  v_comm RECORD;
  v_next_paid BIGINT;
  v_next_status TEXT;
BEGIN
  IF (NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL)
     OR (UPPER(COALESCE(NEW.status, '')) IN ('VOIDED', 'CANCELLED', 'REVERSED')
         AND UPPER(COALESCE(OLD.status, 'ACTIVE')) NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')) THEN
    FOR v_op IN
      SELECT * FROM public.marketing_commission_operations
      WHERE rko_expense_id = NEW.id AND action_type = 'RECORD_PAYOUT' AND voided_at IS NULL
      FOR UPDATE
    LOOP
      UPDATE public.marketing_commission_operations
      SET voided_at = NOW(),
          void_reason = 'РКО аннулирован в кассовом учёте'
      WHERE id = v_op.id;

      SELECT * INTO v_comm
      FROM public.marketing_commissions
      WHERE deal_id = v_op.deal_id
      FOR UPDATE;

      IF FOUND THEN
        v_next_paid := GREATEST(0, v_comm.paid_amount_minor - v_op.amount_minor);
        v_next_status := CASE
          WHEN v_comm.status = 'CANCELLED' THEN 'CANCELLED'
          WHEN v_next_paid >= v_comm.approved_amount_minor AND v_comm.approved_amount_minor > 0 THEN 'PAID'
          WHEN v_next_paid > 0 THEN 'PARTIALLY_PAID'
          WHEN v_comm.approved_amount_minor > 0 THEN 'APPROVED'
          ELSE 'CALCULATED'
        END;

        UPDATE public.marketing_commissions
        SET paid_amount_minor = v_next_paid,
            status = v_next_status,
            updated_at = NOW()
        WHERE deal_id = v_op.deal_id;

        INSERT INTO public.deal_audit_logs (deal_id, user_id, action, changes_json)
        VALUES (
          v_op.deal_id,
          NULL,
          'UPDATE_COMMISSION_STATUS',
          jsonb_build_object(
            'action_type', 'RKO_VOIDED_REVERSAL',
            'rko_expense_id', NEW.id,
            'rko_reference', v_op.rko_reference,
            'reversed_amount_minor', v_op.amount_minor,
            'paid_amount_minor', v_next_paid,
            'status', v_next_status,
            'notes', 'Автоматическое сторнирование выплаты комиссии при аннулировании РКО'
          )
        );
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_void_rko_linked_commission ON public.expenses;
CREATE TRIGGER trg_guard_void_rko_linked_commission
  AFTER UPDATE ON public.expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_void_rko_linked_commission();

COMMIT;

