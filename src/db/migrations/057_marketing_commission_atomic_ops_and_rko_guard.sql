-- =============================================================================
-- Migration: 057_marketing_commission_atomic_ops_and_rko_guard.sql
-- Purpose:
--   1. Create `public.marketing_commission_operations` for PostgreSQL-level
--      idempotency, replay, conflict detection, 1-to-1 RKO linkage, and
--      reconciliation / confirmed payout refund tracking.
--   2. Extend `public.marketing_commissions` with `RECONCILIATION_REQUIRED`
--      status and `reconciliation_required` / `reconciliation_reason` flags.
--   3. Create hardened helper `compute_marketing_commission_from_db` and
--      atomic PostgreSQL RPCs with `SELECT ... FOR UPDATE` row locks:
--      - `approve_marketing_commission_atomic` (computes rate & amount from DB)
--      - `record_marketing_commission_payout_atomic` (enforces approved &
--        current calculated ceilings, mandatory DB partner recipient match,
--        reconciliation guard, canonical lock order)
--      - `confirm_marketing_commission_payout_refund_atomic` (ADMIN-only
--        document-backed refund confirmation to decrease paid_amount_minor)
--   4. Create trigger `trg_guard_void_rko_linked_commission` on `public.expenses`:
--      voiding an RKO marks the payout link as `RECONCILIATION_REQUIRED` and
--      preserves `paid_amount_minor` (never auto-reduces paid amount without
--      documented refund confirmation).
--   5. Revoke EXECUTE from PUBLIC, anon, authenticated; grant ONLY to
--      service_role, postgres; pin `SET search_path = public, pg_temp`.
-- NOTE: Do NOT run on production without explicit owner approval.
-- =============================================================================

BEGIN;

-- Drop any legacy trigger/functions/overloads so no insecure signature remains
DROP TRIGGER IF EXISTS trg_guard_void_rko_linked_commission ON public.expenses;
DROP FUNCTION IF EXISTS public.guard_void_rko_linked_commission();
DROP TRIGGER IF EXISTS trg_prevent_mkt_comm_rko_history_mutation ON public.marketing_commission_rko_history;
DROP FUNCTION IF EXISTS public.prevent_marketing_commission_rko_history_mutation();
DROP FUNCTION IF EXISTS public.reconcile_marketing_commission_payout_with_rko_atomic(BIGINT, BIGINT, BIGINT, BIGINT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.confirm_marketing_commission_payout_refund_atomic(BIGINT, BIGINT, BIGINT, BIGINT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.record_marketing_commission_payout_atomic(BIGINT, BIGINT, BIGINT, BIGINT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.approve_marketing_commission_atomic(BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, BIGINT, BIGINT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.approve_marketing_commission_atomic(BIGINT, BIGINT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.compute_marketing_commission_from_db(BIGINT);

-- Extend marketing_commissions to support RECONCILIATION_REQUIRED
ALTER TABLE public.marketing_commissions
  DROP CONSTRAINT IF EXISTS marketing_commissions_status_check;

ALTER TABLE public.marketing_commissions
  ADD CONSTRAINT marketing_commissions_status_check
  CHECK (status IN (
    'NOT_CALCULATED',
    'CALCULATED',
    'PENDING_APPROVAL',
    'APPROVED',
    'PARTIALLY_PAID',
    'PAID',
    'RECONCILIATION_REQUIRED',
    'CANCELLED'
  ));

ALTER TABLE public.marketing_commissions
  ADD COLUMN IF NOT EXISTS reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reconciliation_reason TEXT;

CREATE TABLE IF NOT EXISTS public.marketing_commission_operations (
  id BIGSERIAL PRIMARY KEY,
  deal_id BIGINT NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL CHECK (action_type IN ('APPROVE', 'RECORD_PAYOUT', 'CONFIRM_PAYOUT_REFUND', 'RECONCILE_PAYOUT_RKO', 'CANCEL')),
  amount_minor BIGINT NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  refunded_amount_minor BIGINT NOT NULL DEFAULT 0 CHECK (refunded_amount_minor >= 0),
  rko_expense_id BIGINT UNIQUE REFERENCES public.expenses(id) ON DELETE RESTRICT,
  rko_reference TEXT,
  reconciliation_status TEXT NOT NULL DEFAULT 'OK' CHECK (reconciliation_status IN ('OK', 'RECONCILIATION_REQUIRED', 'REFUND_CONFIRMED', 'RECONCILED_NEW_RKO')),
  reconciled_rko_expense_id BIGINT UNIQUE REFERENCES public.expenses(id) ON DELETE RESTRICT,
  reconciled_rko_reference TEXT,
  refund_document_ref TEXT,
  refunded_operation_id BIGINT REFERENCES public.marketing_commission_operations(id) ON DELETE RESTRICT,
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketing_comm_ops_unique_refund_doc
  ON public.marketing_commission_operations (LOWER(TRIM(refund_document_ref)))
  WHERE action_type = 'CONFIRM_PAYOUT_REFUND' AND refund_document_ref IS NOT NULL;

ALTER TABLE public.marketing_commission_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketing_commission_operations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.marketing_commission_operations_id_seq FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.marketing_commission_operations TO service_role, postgres;
GRANT USAGE, SELECT ON SEQUENCE public.marketing_commission_operations_id_seq TO service_role, postgres;

DROP POLICY IF EXISTS marketing_commission_operations_service_role ON public.marketing_commission_operations;
CREATE POLICY marketing_commission_operations_service_role ON public.marketing_commission_operations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =============================================================================
-- Immutable append-only history of all RKO links & replacements per payout
-- Guarantees:
--   1. Full audit trail: initial RKO, every void, every replacement, reason,
--      actor, timestamp, and status.
--   2. PostgreSQL-level global uniqueness of RKO usage across ALL initial
--      payouts and ALL replacement RKOs via partial unique index.
--   3. Strict immutability via BEFORE UPDATE OR DELETE trigger.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.marketing_commission_rko_history (
  id BIGSERIAL PRIMARY KEY,
  deal_id BIGINT NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  payout_operation_id BIGINT NOT NULL REFERENCES public.marketing_commission_operations(id) ON DELETE RESTRICT,
  sequence_no INTEGER NOT NULL CHECK (sequence_no >= 1),
  event_type TEXT NOT NULL CHECK (event_type IN ('INITIAL_PAYOUT', 'RKO_VOIDED', 'REPLACEMENT_RKO')),
  rko_expense_id BIGINT NOT NULL REFERENCES public.expenses(id) ON DELETE RESTRICT,
  rko_reference TEXT NOT NULL,
  previous_rko_expense_id BIGINT REFERENCES public.expenses(id) ON DELETE RESTRICT,
  previous_rko_reference TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'VOIDED_RECONCILIATION_REQUIRED')),
  reason TEXT NOT NULL DEFAULT '',
  created_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (payout_operation_id, sequence_no)
);

CREATE INDEX IF NOT EXISTS idx_mkt_comm_rko_history_deal_id
  ON public.marketing_commission_rko_history(deal_id, created_at ASC, id ASC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_comm_rko_history_unique_rko_usage
  ON public.marketing_commission_rko_history(rko_expense_id)
  WHERE event_type IN ('INITIAL_PAYOUT', 'REPLACEMENT_RKO');

ALTER TABLE public.marketing_commission_rko_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketing_commission_rko_history FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.marketing_commission_rko_history_id_seq FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.marketing_commission_rko_history TO service_role, postgres;
GRANT USAGE, SELECT ON SEQUENCE public.marketing_commission_rko_history_id_seq TO service_role, postgres;

DROP POLICY IF EXISTS marketing_commission_rko_history_service_role ON public.marketing_commission_rko_history;
CREATE POLICY marketing_commission_rko_history_service_role ON public.marketing_commission_rko_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.prevent_marketing_commission_rko_history_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_RKO_HISTORY: История документов РКО по комиссиям маркетологов неизменяема (% запрещён)', TG_OP;
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_marketing_commission_rko_history_mutation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_marketing_commission_rko_history_mutation() TO service_role, postgres;

CREATE TRIGGER trg_prevent_mkt_comm_rko_history_mutation
  BEFORE UPDATE OR DELETE ON public.marketing_commission_rko_history
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_marketing_commission_rko_history_mutation();

-- =============================================================================
-- Internal helper: compute live settled amount, tiered rate (0/2/3/4%),
-- and calculated commission strictly from confirmed DB payments & deal terms.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.compute_marketing_commission_from_db(
  p_deal_id BIGINT
)
RETURNS TABLE (
  contract_price_minor BIGINT,
  settled_minor BIGINT,
  rate_bp INTEGER,
  calculated_minor BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deal RECORD;
  v_cash_minor BIGINT := 0;
  v_barter_minor BIGINT := 0;
  v_barter_rows BIGINT := 0;
  v_contract_price BIGINT := 0;
  v_settled BIGINT := 0;
  v_rate INTEGER := 0;
  v_calc BIGINT := 0;
BEGIN
  SELECT id, final_price_minor, barter_amount_minor, refund_amount_minor
  INTO v_deal
  FROM public.deals
  WHERE id = p_deal_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DEAL_NOT_FOUND: Сделка % не найдена', p_deal_id;
  END IF;

  v_contract_price := GREATEST(0, COALESCE(v_deal.final_price_minor, 0));

  SELECT
    COALESCE(SUM(CASE WHEN UPPER(COALESCE(settlement_method, method, '')) <> 'BARTER' THEN GREATEST(0, COALESCE(amount_minor, 0)) ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN UPPER(COALESCE(settlement_method, method, '')) = 'BARTER' THEN GREATEST(0, COALESCE(amount_minor, 0)) ELSE 0 END), 0),
    COUNT(*) FILTER (WHERE UPPER(COALESCE(settlement_method, method, '')) = 'BARTER')
  INTO v_cash_minor, v_barter_minor, v_barter_rows
  FROM public.payments
  WHERE deal_id = p_deal_id
    AND voided_at IS NULL
    AND UPPER(COALESCE(status, 'ACTIVE')) NOT IN ('VOIDED', 'CANCELLED', 'REVERSED');

  IF COALESCE(v_deal.barter_amount_minor, 0) > 0 AND v_barter_rows = 0 THEN
    v_barter_minor := v_barter_minor + v_deal.barter_amount_minor;
  END IF;

  v_settled := GREATEST(0, v_cash_minor + v_barter_minor - GREATEST(0, COALESCE(v_deal.refund_amount_minor, 0)));

  IF v_contract_price > 0 AND v_settled > 0 THEN
    IF (v_settled::NUMERIC * 100) < (v_contract_price::NUMERIC * 5) THEN
      v_rate := 0;
    ELSIF (v_settled::NUMERIC * 100) < (v_contract_price::NUMERIC * 10) THEN
      v_rate := 200;
    ELSIF (v_settled::NUMERIC * 100) <= (v_contract_price::NUMERIC * 15) THEN
      v_rate := 300;
    ELSE
      v_rate := 400;
    END IF;
  ELSE
    v_rate := 0;
  END IF;

  v_calc := CASE
    WHEN v_rate > 0 THEN ROUND((v_contract_price::NUMERIC * v_rate) / 10000)::BIGINT
    ELSE 0
  END;

  RETURN QUERY SELECT v_contract_price, v_settled, v_rate, v_calc;
END;
$$;

REVOKE ALL ON FUNCTION public.compute_marketing_commission_from_db(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_marketing_commission_from_db(BIGINT) TO service_role, postgres;

-- =============================================================================
-- Atomic APPROVE RPC (with advisory idempotency lock, FOR UPDATE lock & DB calculation)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.approve_marketing_commission_atomic(
  p_deal_id BIGINT,
  p_actor_id BIGINT,
  p_idempotency_key TEXT,
  p_notes TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key TEXT := NULLIF(TRIM(COALESCE(p_idempotency_key, '')), '');
  v_norm_notes TEXT := COALESCE(TRIM(COALESCE(p_notes, '')), '');
  v_fingerprint TEXT;
  v_existing_op RECORD;
  v_deal RECORD;
  v_comm RECORD;
  v_metrics RECORD;
  v_approved_minor BIGINT;
  v_additional_minor BIGINT;
  v_new_status TEXT;
  v_now TIMESTAMPTZ := NOW();
  v_snapshot JSONB;
BEGIN
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: Параметр idempotency_key обязателен';
  END IF;

  v_fingerprint := p_deal_id::TEXT
    || '|APPROVE|'
    || COALESCE(p_actor_id::TEXT, '')
    || '|' || v_norm_notes;

  -- Serialize concurrent requests sharing the same idempotency_key
  PERFORM pg_advisory_xact_lock(hashtextextended('mkt_comm_idemp:' || v_key, 0));

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

  -- Canonical lock order: deals -> marketing_commissions
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

  SELECT * INTO v_metrics
  FROM public.compute_marketing_commission_from_db(p_deal_id);

  v_approved_minor := COALESCE(v_metrics.calculated_minor, 0);
  IF v_approved_minor <= 0 THEN
    RAISE EXCEPTION 'APPROVED_COMMISSION_MUST_BE_POSITIVE: По подтверждённым платежам расчётная комиссия равна 0 (оплачено менее 5%% договора)';
  END IF;

  SELECT * INTO v_comm
  FROM public.marketing_commissions
  WHERE deal_id = p_deal_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_comm.status = 'CANCELLED' THEN
      RAISE EXCEPTION 'COMMISSION_CANCELLED: Нельзя утвердить отменённую комиссию';
    END IF;
    IF v_comm.status = 'RECONCILIATION_REQUIRED' OR COALESCE(v_comm.reconciliation_required, FALSE) THEN
      RAISE EXCEPTION 'COMMISSION_RECONCILIATION_REQUIRED: По договору требуется сверка после аннулирования РКО; утверждение заблокировано';
    END IF;
    IF v_approved_minor < v_comm.paid_amount_minor THEN
      RAISE EXCEPTION 'APPROVED_BELOW_PAID: Расчётная сумма (%) меньше уже выплаченной (%)', v_approved_minor, v_comm.paid_amount_minor;
    END IF;
    IF v_comm.status IN ('APPROVED', 'PARTIALLY_PAID', 'PAID') AND v_approved_minor <= v_comm.approved_amount_minor THEN
      RAISE EXCEPTION 'COMMISSION_ALREADY_APPROVED: Комиссия по данному договору уже утверждена';
    END IF;

    v_additional_minor := GREATEST(0, v_approved_minor - v_comm.approved_amount_minor);
    v_new_status := CASE
      WHEN v_comm.paid_amount_minor >= v_approved_minor THEN 'PAID'
      WHEN v_comm.paid_amount_minor > 0 THEN 'PARTIALLY_PAID'
      ELSE 'APPROVED'
    END;

    UPDATE public.marketing_commissions
    SET partner_id = COALESCE(v_deal.marketing_partner_id, partner_id),
        contract_price_minor = v_metrics.contract_price_minor,
        commission_type = CASE WHEN v_metrics.rate_bp > 0 THEN 'PERCENT' ELSE 'NONE' END,
        commission_rate_bp = v_metrics.rate_bp,
        calculated_amount_minor = v_metrics.calculated_minor,
        approved_amount_minor = v_approved_minor,
        status = v_new_status,
        approved_at = v_now,
        approved_by = p_actor_id,
        notes = NULLIF(v_norm_notes, ''),
        updated_at = v_now
    WHERE deal_id = p_deal_id;
  ELSE
    v_additional_minor := v_approved_minor;
    v_new_status := 'APPROVED';
    INSERT INTO public.marketing_commissions (
      deal_id, partner_id, contract_price_minor, commission_type, commission_rate_bp,
      calculated_amount_minor, approved_amount_minor, paid_amount_minor, status,
      accrued_at, approved_at, approved_by, notes, updated_at
    ) VALUES (
      p_deal_id, v_deal.marketing_partner_id, v_metrics.contract_price_minor,
      CASE WHEN v_metrics.rate_bp > 0 THEN 'PERCENT' ELSE 'NONE' END,
      v_metrics.rate_bp,
      v_metrics.calculated_minor,
      v_approved_minor, 0, v_new_status,
      v_now, v_now, p_actor_id, NULLIF(v_norm_notes, ''), v_now
    );
  END IF;

  v_snapshot := jsonb_build_object(
    'deal_id', p_deal_id,
    'action_type', 'APPROVE',
    'commission_rate_bp', v_metrics.rate_bp,
    'calculated_amount_minor', v_metrics.calculated_minor,
    'approved_amount_minor', v_approved_minor,
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
    v_fingerprint, v_snapshot, v_norm_notes, p_actor_id
  );

  INSERT INTO public.deal_audit_logs (deal_id, user_id, action, changes_json)
  VALUES (
    p_deal_id,
    p_actor_id,
    'UPDATE_COMMISSION_STATUS',
    jsonb_build_object(
      'action_type', 'APPROVE',
      'commission_rate_bp', v_metrics.rate_bp,
      'calculated_amount_minor', v_metrics.calculated_minor,
      'approved_amount_minor', v_approved_minor,
      'additional_accrual_minor', v_additional_minor,
      'status', v_new_status,
      'approved_at', v_now,
      'approved_by', p_actor_id,
      'idempotency_key', v_key,
      'notes', v_norm_notes
    )
  );

  RETURN v_snapshot;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_marketing_commission_atomic(BIGINT, BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_marketing_commission_atomic(BIGINT, BIGINT, TEXT, TEXT) TO service_role, postgres;

-- =============================================================================
-- Atomic RECORD_PAYOUT RPC
-- Canonical lock order: expenses -> deals -> marketing_commissions
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
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key TEXT := NULLIF(TRIM(COALESCE(p_idempotency_key, '')), '');
  v_norm_expected TEXT := LOWER(TRIM(COALESCE(p_expected_partner_name, '')));
  v_norm_notes TEXT := COALESCE(TRIM(COALESCE(p_notes, '')), '');
  v_fingerprint TEXT;
  v_existing_op RECORD;
  v_rko RECORD;
  v_deal RECORD;
  v_comm RECORD;
  v_metrics RECORD;
  v_db_partner_id BIGINT;
  v_db_partner_name TEXT;
  v_rko_recipient TEXT;
  v_next_paid_minor BIGINT;
  v_next_status TEXT;
  v_rko_ref TEXT;
  v_op_id BIGINT;
  v_now TIMESTAMPTZ := NOW();
  v_snapshot JSONB;
BEGIN
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: Параметр idempotency_key обязателен';
  END IF;

  IF p_rko_expense_id IS NULL THEN
    RAISE EXCEPTION 'RKO_REQUIRED: Для регистрации выплаты требуется привязка к проведённому РКО';
  END IF;

  v_fingerprint := p_deal_id::TEXT
    || '|RECORD_PAYOUT|'
    || COALESCE(p_actor_id::TEXT, '')
    || '|' || COALESCE(p_payout_minor, 0)::TEXT
    || '|' || p_rko_expense_id::TEXT
    || '|' || v_norm_expected
    || '|' || v_norm_notes;

  -- Serialize concurrent requests sharing the same idempotency_key
  PERFORM pg_advisory_xact_lock(hashtextextended('mkt_comm_idemp:' || v_key, 0));

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

  -- 1. Lock RKO first (matches trigger lock order: expenses -> deals -> marketing_commissions)
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

  -- Block ANY reuse of an RKO that was ever linked to a commission payout (even if later voided)
  IF EXISTS (
    SELECT 1 FROM public.marketing_commission_operations
    WHERE rko_expense_id = p_rko_expense_id
       OR reconciled_rko_expense_id = p_rko_expense_id
  ) OR EXISTS (
    SELECT 1 FROM public.marketing_commission_rko_history
    WHERE rko_expense_id = p_rko_expense_id
      AND event_type IN ('INITIAL_PAYOUT', 'REPLACEMENT_RKO')
  ) THEN
    RAISE EXCEPTION 'RKO_ALREADY_LINKED: Этот РКО уже привязан к выплате комиссии';
  END IF;

  IF COALESCE(v_rko.amount_minor, 0) <> p_payout_minor THEN
    RAISE EXCEPTION 'RKO_AMOUNT_MISMATCH: Сумма РКО (%) не совпадает с суммой выплаты (%)', v_rko.amount_minor, p_payout_minor;
  END IF;

  v_rko_recipient := NULLIF(TRIM(COALESCE(v_rko.recipient, '')), '');
  IF v_rko_recipient IS NULL THEN
    RAISE EXCEPTION 'RKO_RECIPIENT_REQUIRED: В документе РКО #% не указан получатель', p_rko_expense_id;
  END IF;

  -- 2. Lock Deal
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

  IF UPPER(COALESCE(v_deal.status, '')) <> 'SIGNED' THEN
    RAISE EXCEPTION 'DEAL_NOT_SIGNED: Выплата разрешена только по подписанному договору';
  END IF;

  IF UPPER(COALESCE(v_deal.sales_source, 'UNSPECIFIED')) <> 'MARKETER' THEN
    RAISE EXCEPTION 'COMMISSION_NOT_ALLOWED_FOR_SOURCE: Выплата разрешена только для MARKETER';
  END IF;

  -- 3. Lock Commission
  SELECT * INTO v_comm
  FROM public.marketing_commissions
  WHERE deal_id = p_deal_id
  FOR UPDATE;

  IF NOT FOUND OR v_comm.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'COMMISSION_CANCELLED_OR_MISSING: Выплата по отменённой или неутверждённой комиссии запрещена';
  END IF;

  IF v_comm.status = 'RECONCILIATION_REQUIRED' OR COALESCE(v_comm.reconciliation_required, FALSE) THEN
    RAISE EXCEPTION 'COMMISSION_RECONCILIATION_REQUIRED: По договору требуется сверка после аннулирования РКО; повторная выплата заблокирована';
  END IF;

  IF v_comm.status NOT IN ('APPROVED', 'PARTIALLY_PAID') THEN
    RAISE EXCEPTION 'COMMISSION_NOT_APPROVED: Выплата возможна только по утверждённой комиссии';
  END IF;

  -- 4. Mandatory RKO recipient validation against DB partner record
  v_db_partner_id := COALESCE(v_comm.partner_id, v_deal.marketing_partner_id);
  IF v_db_partner_id IS NOT NULL THEN
    SELECT NULLIF(TRIM(name), '') INTO v_db_partner_name
    FROM public.marketing_partners
    WHERE id = v_db_partner_id;
  ELSE
    v_db_partner_name := NULLIF(TRIM(COALESCE(v_deal.marketer_name, '')), '');
  END IF;

  IF v_db_partner_name IS NULL THEN
    RAISE EXCEPTION 'PARTNER_REQUIRED_FOR_PAYOUT: Для выплаты комиссии у договора должен быть указан маркетинговый партнёр в БД';
  END IF;

  IF LOWER(v_rko_recipient) <> LOWER(v_db_partner_name) THEN
    RAISE EXCEPTION 'RKO_RECIPIENT_MISMATCH: Получатель в РКО (%) не совпадает с партнёром договора в БД (%)', v_rko_recipient, v_db_partner_name;
  END IF;

  IF v_norm_expected <> '' AND v_norm_expected <> LOWER(v_db_partner_name) THEN
    RAISE EXCEPTION 'RKO_RECIPIENT_MISMATCH: Переданный получатель (%) не совпадает с партнёром договора в БД (%)', p_expected_partner_name, v_db_partner_name;
  END IF;

  -- 5. Enforce BOTH approved ceiling AND live calculated ceiling from confirmed payments
  SELECT * INTO v_metrics
  FROM public.compute_marketing_commission_from_db(p_deal_id);

  IF v_comm.paid_amount_minor > v_metrics.calculated_minor THEN
    RAISE EXCEPTION 'COMMISSION_OVERPAID: Зафиксирована переплата комиссии, новые выплаты заблокированы';
  END IF;

  v_next_paid_minor := v_comm.paid_amount_minor + p_payout_minor;

  IF v_next_paid_minor > v_comm.approved_amount_minor THEN
    RAISE EXCEPTION 'PAYOUT_EXCEEDS_APPROVED: Сумма выплаты превышает остаток утверждённой комиссии';
  END IF;

  IF v_next_paid_minor > v_metrics.calculated_minor THEN
    RAISE EXCEPTION 'PAYOUT_EXCEEDS_CALCULATED: Сумма выплаты (%) превышает текущую расчётную комиссию (%)', v_next_paid_minor, v_metrics.calculated_minor;
  END IF;

  v_rko_ref := COALESCE(NULLIF(TRIM(v_rko.reference), ''), 'РКО-' || v_rko.id::TEXT);
  v_next_status := CASE WHEN v_next_paid_minor >= v_comm.approved_amount_minor THEN 'PAID' ELSE 'PARTIALLY_PAID' END;

  UPDATE public.marketing_commissions
  SET calculated_amount_minor = v_metrics.calculated_minor,
      commission_rate_bp = v_metrics.rate_bp,
      paid_amount_minor = v_next_paid_minor,
      status = v_next_status,
      paid_at = v_now,
      updated_at = v_now
  WHERE deal_id = p_deal_id;

  v_snapshot := jsonb_build_object(
    'deal_id', p_deal_id,
    'action_type', 'RECORD_PAYOUT',
    'payout_delta_minor', p_payout_minor,
    'paid_amount_minor', v_next_paid_minor,
    'calculated_amount_minor', v_metrics.calculated_minor,
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
    v_key, v_fingerprint, v_snapshot, v_norm_notes, p_actor_id
  )
  RETURNING id INTO v_op_id;

  INSERT INTO public.marketing_commission_rko_history (
    deal_id, payout_operation_id, sequence_no, event_type,
    rko_expense_id, rko_reference, previous_rko_expense_id, previous_rko_reference,
    status, reason, created_by, created_at
  ) VALUES (
    p_deal_id, v_op_id, 1, 'INITIAL_PAYOUT',
    p_rko_expense_id, v_rko_ref, NULL, NULL,
    'ACTIVE', COALESCE(NULLIF(v_norm_notes, ''), 'Первичная выплата комиссии'), p_actor_id, v_now
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
      'notes', v_norm_notes
    )
  );

  RETURN v_snapshot;
END;
$$;

REVOKE ALL ON FUNCTION public.record_marketing_commission_payout_atomic(BIGINT, BIGINT, BIGINT, BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_marketing_commission_payout_atomic(BIGINT, BIGINT, BIGINT, BIGINT, TEXT, TEXT, TEXT) TO service_role, postgres;

-- =============================================================================
-- Atomic CONFIRM_PAYOUT_REFUND RPC (ADMIN only at app layer)
-- Only reduces paid_amount_minor after documented refund confirmation.
-- Canonical lock order: deals -> marketing_commissions -> marketing_commission_operations
-- =============================================================================
CREATE OR REPLACE FUNCTION public.confirm_marketing_commission_payout_refund_atomic(
  p_deal_id BIGINT,
  p_actor_id BIGINT,
  p_payout_operation_id BIGINT,
  p_refund_amount_minor BIGINT,
  p_refund_document_ref TEXT,
  p_idempotency_key TEXT,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key TEXT := NULLIF(TRIM(COALESCE(p_idempotency_key, '')), '');
  v_doc_ref TEXT := NULLIF(TRIM(COALESCE(p_refund_document_ref, '')), '');
  v_reason TEXT := NULLIF(TRIM(COALESCE(p_reason, '')), '');
  v_fingerprint TEXT;
  v_existing_op RECORD;
  v_deal RECORD;
  v_comm RECORD;
  v_op RECORD;
  v_remaining_op_minor BIGINT;
  v_new_refunded_minor BIGINT;
  v_new_op_reconciliation_status TEXT;
  v_has_other_pending BOOLEAN := FALSE;
  v_next_paid_minor BIGINT;
  v_next_status TEXT;
  v_now TIMESTAMPTZ := NOW();
  v_snapshot JSONB;
BEGIN
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: Параметр idempotency_key обязателен';
  END IF;

  IF v_doc_ref IS NULL THEN
    RAISE EXCEPTION 'REFUND_DOCUMENT_REQUIRED: Укажите ссылку на документ возврата денег';
  END IF;

  IF v_reason IS NULL OR LENGTH(v_reason) < 3 THEN
    RAISE EXCEPTION 'REFUND_REASON_REQUIRED: Укажите основание подтверждённого возврата денег';
  END IF;

  IF COALESCE(p_refund_amount_minor, 0) <= 0 THEN
    RAISE EXCEPTION 'INVALID_REFUND_AMOUNT: Сумма возврата должна быть > 0';
  END IF;

  v_fingerprint := p_deal_id::TEXT
    || '|CONFIRM_PAYOUT_REFUND|'
    || COALESCE(p_actor_id::TEXT, '')
    || '|' || COALESCE(p_payout_operation_id, 0)::TEXT
    || '|' || p_refund_amount_minor::TEXT
    || '|' || LOWER(v_doc_ref)
    || '|' || v_reason;

  PERFORM pg_advisory_xact_lock(hashtextextended('mkt_comm_idemp:' || v_key, 0));

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

  -- Canonical lock order: deals -> marketing_commissions -> marketing_commission_operations
  SELECT * INTO v_deal
  FROM public.deals
  WHERE id = p_deal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DEAL_NOT_FOUND: Сделка % не найдена', p_deal_id;
  END IF;

  SELECT * INTO v_comm
  FROM public.marketing_commissions
  WHERE deal_id = p_deal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMMISSION_NOT_FOUND: Запись комиссии по сделке % не найдена', p_deal_id;
  END IF;

  SELECT * INTO v_op
  FROM public.marketing_commission_operations
  WHERE id = p_payout_operation_id
    AND deal_id = p_deal_id
    AND action_type = 'RECORD_PAYOUT'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT_OPERATION_NOT_FOUND: Операция выплаты #% по сделке % не найдена', p_payout_operation_id, p_deal_id;
  END IF;

  IF v_op.reconciliation_status <> 'RECONCILIATION_REQUIRED' THEN
    RAISE EXCEPTION 'PAYOUT_NOT_PENDING_RECONCILIATION: Операция выплаты #% не требует сверки (статус: %)', p_payout_operation_id, v_op.reconciliation_status;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.marketing_commission_operations
    WHERE action_type = 'CONFIRM_PAYOUT_REFUND'
      AND LOWER(TRIM(COALESCE(refund_document_ref, ''))) = LOWER(v_doc_ref)
  ) THEN
    RAISE EXCEPTION 'REFUND_DOCUMENT_ALREADY_USED: Документ возврата % уже использован для подтверждения возврата', v_doc_ref;
  END IF;

  v_remaining_op_minor := GREATEST(0, v_op.amount_minor - COALESCE(v_op.refunded_amount_minor, 0));
  IF p_refund_amount_minor > v_remaining_op_minor OR p_refund_amount_minor > v_comm.paid_amount_minor THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_PAID: Сумма возврата (%) превышает невозвращённый остаток выплаты (%)', p_refund_amount_minor, LEAST(v_remaining_op_minor, v_comm.paid_amount_minor);
  END IF;

  v_new_refunded_minor := COALESCE(v_op.refunded_amount_minor, 0) + p_refund_amount_minor;
  v_new_op_reconciliation_status := CASE
    WHEN v_new_refunded_minor >= v_op.amount_minor THEN 'REFUND_CONFIRMED'
    ELSE 'RECONCILIATION_REQUIRED'
  END;

  UPDATE public.marketing_commission_operations
  SET refunded_amount_minor = v_new_refunded_minor,
      reconciliation_status = v_new_op_reconciliation_status,
      refund_document_ref = v_doc_ref
  WHERE id = v_op.id;

  v_next_paid_minor := GREATEST(0, v_comm.paid_amount_minor - p_refund_amount_minor);

  SELECT EXISTS (
    SELECT 1 FROM public.marketing_commission_operations
    WHERE deal_id = p_deal_id
      AND action_type = 'RECORD_PAYOUT'
      AND reconciliation_status = 'RECONCILIATION_REQUIRED'
  ) INTO v_has_other_pending;

  v_next_status := CASE
    WHEN v_has_other_pending THEN 'RECONCILIATION_REQUIRED'
    WHEN v_comm.status = 'CANCELLED' THEN 'CANCELLED'
    WHEN v_next_paid_minor >= v_comm.approved_amount_minor AND v_comm.approved_amount_minor > 0 THEN 'PAID'
    WHEN v_next_paid_minor > 0 THEN 'PARTIALLY_PAID'
    WHEN v_comm.approved_amount_minor > 0 THEN 'APPROVED'
    ELSE 'CALCULATED'
  END;

  UPDATE public.marketing_commissions
  SET paid_amount_minor = v_next_paid_minor,
      reconciliation_required = v_has_other_pending,
      reconciliation_reason = CASE WHEN v_has_other_pending THEN v_comm.reconciliation_reason ELSE NULL END,
      status = v_next_status,
      paid_at = CASE WHEN v_next_paid_minor = 0 THEN NULL ELSE paid_at END,
      updated_at = v_now
  WHERE deal_id = p_deal_id;

  v_snapshot := jsonb_build_object(
    'deal_id', p_deal_id,
    'action_type', 'CONFIRM_PAYOUT_REFUND',
    'payout_operation_id', p_payout_operation_id,
    'refund_amount_minor', p_refund_amount_minor,
    'operation_refunded_amount_minor', v_new_refunded_minor,
    'operation_remaining_minor', GREATEST(0, v_op.amount_minor - v_new_refunded_minor),
    'operation_reconciliation_status', v_new_op_reconciliation_status,
    'refund_document_ref', v_doc_ref,
    'paid_amount_minor', v_next_paid_minor,
    'reconciliation_required', v_has_other_pending,
    'status', v_next_status,
    'idempotent', FALSE
  );

  INSERT INTO public.marketing_commission_operations (
    deal_id, action_type, amount_minor, refund_document_ref, refunded_operation_id,
    idempotency_key, request_fingerprint, response_snapshot, notes, created_by
  ) VALUES (
    p_deal_id, 'CONFIRM_PAYOUT_REFUND', p_refund_amount_minor, v_doc_ref, p_payout_operation_id,
    v_key, v_fingerprint, v_snapshot, v_reason, p_actor_id
  );

  INSERT INTO public.deal_audit_logs (deal_id, user_id, action, changes_json)
  VALUES (
    p_deal_id,
    p_actor_id,
    'UPDATE_COMMISSION_STATUS',
    jsonb_build_object(
      'action_type', 'CONFIRM_PAYOUT_REFUND',
      'payout_operation_id', p_payout_operation_id,
      'rko_expense_id', v_op.rko_expense_id,
      'rko_reference', v_op.rko_reference,
      'refund_amount_minor', p_refund_amount_minor,
      'operation_refunded_amount_minor', v_new_refunded_minor,
      'operation_reconciliation_status', v_new_op_reconciliation_status,
      'refund_document_ref', v_doc_ref,
      'paid_amount_minor', v_next_paid_minor,
      'reconciliation_required', v_has_other_pending,
      'status', v_next_status,
      'idempotency_key', v_key,
      'notes', v_reason
    )
  );

  RETURN v_snapshot;
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_marketing_commission_payout_refund_atomic(BIGINT, BIGINT, BIGINT, BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_marketing_commission_payout_refund_atomic(BIGINT, BIGINT, BIGINT, BIGINT, TEXT, TEXT, TEXT) TO service_role, postgres;

-- =============================================================================
-- Atomic RECONCILE_PAYOUT_RKO RPC (ADMIN only at app layer)
-- Completes reconciliation when RKO was voided, money WAS actually paid to
-- marketer, and admin links a valid replacement RKO WITHOUT moving money again.
-- Canonical lock order: expenses -> deals -> marketing_commissions -> marketing_commission_operations
-- =============================================================================
CREATE OR REPLACE FUNCTION public.reconcile_marketing_commission_payout_with_rko_atomic(
  p_deal_id BIGINT,
  p_actor_id BIGINT,
  p_payout_operation_id BIGINT,
  p_new_rko_expense_id BIGINT,
  p_expected_partner_name TEXT,
  p_idempotency_key TEXT,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key TEXT := NULLIF(TRIM(COALESCE(p_idempotency_key, '')), '');
  v_norm_expected TEXT := LOWER(TRIM(COALESCE(p_expected_partner_name, '')));
  v_reason TEXT := NULLIF(TRIM(COALESCE(p_reason, '')), '');
  v_fingerprint TEXT;
  v_existing_op RECORD;
  v_new_rko RECORD;
  v_deal RECORD;
  v_comm RECORD;
  v_op RECORD;
  v_db_partner_id BIGINT;
  v_db_partner_name TEXT;
  v_rko_recipient TEXT;
  v_expected_amount_minor BIGINT;
  v_prev_rko_id BIGINT;
  v_prev_rko_ref TEXT;
  v_new_rko_ref TEXT;
  v_next_seq INTEGER;
  v_has_other_pending BOOLEAN := FALSE;
  v_next_status TEXT;
  v_now TIMESTAMPTZ := NOW();
  v_snapshot JSONB;
BEGIN
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: Параметр idempotency_key обязателен';
  END IF;

  IF p_new_rko_expense_id IS NULL THEN
    RAISE EXCEPTION 'RKO_REQUIRED: Укажите ID нового проведённого РКО для завершения сверки';
  END IF;

  IF v_reason IS NULL OR LENGTH(v_reason) < 3 THEN
    RAISE EXCEPTION 'RECONCILE_REASON_REQUIRED: Укажите основание завершения сверки с заменой РКО';
  END IF;

  v_fingerprint := p_deal_id::TEXT
    || '|RECONCILE_PAYOUT_RKO|'
    || COALESCE(p_actor_id::TEXT, '')
    || '|' || COALESCE(p_payout_operation_id, 0)::TEXT
    || '|' || p_new_rko_expense_id::TEXT
    || '|' || v_norm_expected
    || '|' || v_reason;

  PERFORM pg_advisory_xact_lock(hashtextextended('mkt_comm_idemp:' || v_key, 0));

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

  -- 1. Lock replacement RKO first
  SELECT * INTO v_new_rko
  FROM public.expenses
  WHERE id = p_new_rko_expense_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RKO_NOT_FOUND: Документ РКО #% не найден', p_new_rko_expense_id;
  END IF;

  IF v_new_rko.voided_at IS NOT NULL OR UPPER(COALESCE(v_new_rko.status, 'ACTIVE')) IN ('VOIDED', 'CANCELLED', 'REVERSED') THEN
    RAISE EXCEPTION 'RKO_VOIDED: Нельзя привязать аннулированный РКО';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.marketing_commission_operations
    WHERE rko_expense_id = p_new_rko_expense_id
       OR reconciled_rko_expense_id = p_new_rko_expense_id
  ) OR EXISTS (
    SELECT 1 FROM public.marketing_commission_rko_history
    WHERE rko_expense_id = p_new_rko_expense_id
      AND event_type IN ('INITIAL_PAYOUT', 'REPLACEMENT_RKO')
  ) THEN
    RAISE EXCEPTION 'RKO_ALREADY_LINKED: Этот РКО уже привязан к выплате комиссии';
  END IF;

  v_rko_recipient := NULLIF(TRIM(COALESCE(v_new_rko.recipient, '')), '');
  IF v_rko_recipient IS NULL THEN
    RAISE EXCEPTION 'RKO_RECIPIENT_REQUIRED: В документе РКО #% не указан получатель', p_new_rko_expense_id;
  END IF;

  -- 2. Lock Deal
  SELECT * INTO v_deal
  FROM public.deals
  WHERE id = p_deal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DEAL_NOT_FOUND: Сделка % не найдена', p_deal_id;
  END IF;

  -- 3. Lock Commission
  SELECT * INTO v_comm
  FROM public.marketing_commissions
  WHERE deal_id = p_deal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMMISSION_NOT_FOUND: Запись комиссии по сделке % не найдена', p_deal_id;
  END IF;

  -- 4. Lock Payout Operation
  SELECT * INTO v_op
  FROM public.marketing_commission_operations
  WHERE id = p_payout_operation_id
    AND deal_id = p_deal_id
    AND action_type = 'RECORD_PAYOUT'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT_OPERATION_NOT_FOUND: Операция выплаты #% по сделке % не найдена', p_payout_operation_id, p_deal_id;
  END IF;

  IF v_op.reconciliation_status <> 'RECONCILIATION_REQUIRED' THEN
    RAISE EXCEPTION 'PAYOUT_NOT_PENDING_RECONCILIATION: Операция выплаты #% не требует сверки (статус: %)', p_payout_operation_id, v_op.reconciliation_status;
  END IF;

  -- Validate partner recipient against DB
  v_db_partner_id := COALESCE(v_comm.partner_id, v_deal.marketing_partner_id);
  IF v_db_partner_id IS NOT NULL THEN
    SELECT NULLIF(TRIM(name), '') INTO v_db_partner_name
    FROM public.marketing_partners
    WHERE id = v_db_partner_id;
  ELSE
    v_db_partner_name := NULLIF(TRIM(COALESCE(v_deal.marketer_name, '')), '');
  END IF;

  IF v_db_partner_name IS NULL THEN
    RAISE EXCEPTION 'PARTNER_REQUIRED_FOR_PAYOUT: Для сверки у договора должен быть указан маркетинговый партнёр в БД';
  END IF;

  IF LOWER(v_rko_recipient) <> LOWER(v_db_partner_name) THEN
    RAISE EXCEPTION 'RKO_RECIPIENT_MISMATCH: Получатель в новом РКО (%) не совпадает с партнёром договора в БД (%)', v_rko_recipient, v_db_partner_name;
  END IF;

  IF v_norm_expected <> '' AND v_norm_expected <> LOWER(v_db_partner_name) THEN
    RAISE EXCEPTION 'RKO_RECIPIENT_MISMATCH: Переданный получатель (%) не совпадает с партнёром договора в БД (%)', p_expected_partner_name, v_db_partner_name;
  END IF;

  v_expected_amount_minor := GREATEST(0, v_op.amount_minor - COALESCE(v_op.refunded_amount_minor, 0));
  IF COALESCE(v_new_rko.amount_minor, 0) <> v_expected_amount_minor THEN
    RAISE EXCEPTION 'RKO_AMOUNT_MISMATCH: Сумма нового РКО (%) не совпадает с невозвращённой суммой выплаты (%)', v_new_rko.amount_minor, v_expected_amount_minor;
  END IF;

  v_prev_rko_id := COALESCE(v_op.reconciled_rko_expense_id, v_op.rko_expense_id);
  v_prev_rko_ref := COALESCE(v_op.reconciled_rko_reference, v_op.rko_reference);
  v_new_rko_ref := COALESCE(NULLIF(TRIM(v_new_rko.reference), ''), 'РКО-' || v_new_rko.id::TEXT);

  UPDATE public.marketing_commission_operations
  SET reconciliation_status = 'RECONCILED_NEW_RKO',
      reconciled_rko_expense_id = p_new_rko_expense_id,
      reconciled_rko_reference = v_new_rko_ref
  WHERE id = v_op.id;

  SELECT COALESCE(MAX(sequence_no), 0) + 1
  INTO v_next_seq
  FROM public.marketing_commission_rko_history
  WHERE payout_operation_id = p_payout_operation_id;

  INSERT INTO public.marketing_commission_rko_history (
    deal_id, payout_operation_id, sequence_no, event_type,
    rko_expense_id, rko_reference, previous_rko_expense_id, previous_rko_reference,
    status, reason, created_by, created_at
  ) VALUES (
    p_deal_id, p_payout_operation_id, v_next_seq, 'REPLACEMENT_RKO',
    p_new_rko_expense_id, v_new_rko_ref, v_prev_rko_id, v_prev_rko_ref,
    'ACTIVE', v_reason, p_actor_id, v_now
  );

  SELECT EXISTS (
    SELECT 1 FROM public.marketing_commission_operations
    WHERE deal_id = p_deal_id
      AND action_type = 'RECORD_PAYOUT'
      AND reconciliation_status = 'RECONCILIATION_REQUIRED'
  ) INTO v_has_other_pending;

  -- paid_amount_minor is PRESERVED (zero duplicate money movement!)
  v_next_status := CASE
    WHEN v_has_other_pending THEN 'RECONCILIATION_REQUIRED'
    WHEN v_comm.status = 'CANCELLED' THEN 'CANCELLED'
    WHEN v_comm.paid_amount_minor >= v_comm.approved_amount_minor AND v_comm.approved_amount_minor > 0 THEN 'PAID'
    WHEN v_comm.paid_amount_minor > 0 THEN 'PARTIALLY_PAID'
    WHEN v_comm.approved_amount_minor > 0 THEN 'APPROVED'
    ELSE 'CALCULATED'
  END;

  UPDATE public.marketing_commissions
  SET reconciliation_required = v_has_other_pending,
      reconciliation_reason = CASE WHEN v_has_other_pending THEN v_comm.reconciliation_reason ELSE NULL END,
      status = v_next_status,
      updated_at = v_now
  WHERE deal_id = p_deal_id;

  v_snapshot := jsonb_build_object(
    'deal_id', p_deal_id,
    'action_type', 'RECONCILE_PAYOUT_RKO',
    'payout_operation_id', p_payout_operation_id,
    'initial_rko_expense_id', v_op.rko_expense_id,
    'old_rko_expense_id', v_prev_rko_id,
    'old_rko_reference', v_prev_rko_ref,
    'new_rko_expense_id', p_new_rko_expense_id,
    'new_rko_reference', v_new_rko_ref,
    'rko_history_sequence', v_next_seq,
    'paid_amount_minor', v_comm.paid_amount_minor,
    'reconciliation_required', v_has_other_pending,
    'status', v_next_status,
    'idempotent', FALSE
  );

  INSERT INTO public.marketing_commission_operations (
    deal_id, action_type, amount_minor, refunded_operation_id,
    idempotency_key, request_fingerprint, response_snapshot, notes, created_by
  ) VALUES (
    p_deal_id, 'RECONCILE_PAYOUT_RKO', 0, p_payout_operation_id,
    v_key, v_fingerprint, v_snapshot, v_reason, p_actor_id
  );

  INSERT INTO public.deal_audit_logs (deal_id, user_id, action, changes_json)
  VALUES (
    p_deal_id,
    p_actor_id,
    'UPDATE_COMMISSION_STATUS',
    jsonb_build_object(
      'action_type', 'RECONCILE_PAYOUT_RKO',
      'payout_operation_id', p_payout_operation_id,
      'initial_rko_expense_id', v_op.rko_expense_id,
      'old_rko_expense_id', v_prev_rko_id,
      'old_rko_reference', v_prev_rko_ref,
      'new_rko_expense_id', p_new_rko_expense_id,
      'new_rko_reference', v_new_rko_ref,
      'rko_history_sequence', v_next_seq,
      'paid_amount_minor', v_comm.paid_amount_minor,
      'reconciliation_required', v_has_other_pending,
      'status', v_next_status,
      'idempotency_key', v_key,
      'notes', v_reason
    )
  );

  RETURN v_snapshot;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_marketing_commission_payout_with_rko_atomic(BIGINT, BIGINT, BIGINT, BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_marketing_commission_payout_with_rko_atomic(BIGINT, BIGINT, BIGINT, BIGINT, TEXT, TEXT, TEXT) TO service_role, postgres;

-- =============================================================================
-- Trigger: When a linked RKO is voided in cash accounting, DO NOT auto-reduce
-- `paid_amount_minor`. Mark operation & commission as RECONCILIATION_REQUIRED,
-- preserve paid amount to block duplicate payout, and log audit warning.
-- Canonical lock order: (expenses locked by UPDATE) -> deals -> marketing_commissions -> marketing_commission_operations
-- =============================================================================
CREATE OR REPLACE FUNCTION public.guard_void_rko_linked_commission()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_candidate RECORD;
  v_op RECORD;
  v_comm RECORD;
  v_next_status TEXT;
  v_next_seq INTEGER;
  v_voided_rko_ref TEXT;
BEGIN
  IF (NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL)
     OR (UPPER(COALESCE(NEW.status, '')) IN ('VOIDED', 'CANCELLED', 'REVERSED')
         AND UPPER(COALESCE(OLD.status, 'ACTIVE')) NOT IN ('VOIDED', 'CANCELLED', 'REVERSED')) THEN
    FOR v_candidate IN
      SELECT id, deal_id
      FROM public.marketing_commission_operations
      WHERE COALESCE(reconciled_rko_expense_id, rko_expense_id) = NEW.id
        AND action_type = 'RECORD_PAYOUT'
        AND reconciliation_status IN ('OK', 'RECONCILED_NEW_RKO')
      ORDER BY deal_id, id
    LOOP
      -- Canonical lock order: deals -> marketing_commissions -> marketing_commission_operations
      PERFORM 1 FROM public.deals WHERE id = v_candidate.deal_id FOR UPDATE;

      SELECT * INTO v_comm
      FROM public.marketing_commissions
      WHERE deal_id = v_candidate.deal_id
      FOR UPDATE;

      SELECT * INTO v_op
      FROM public.marketing_commission_operations
      WHERE id = v_candidate.id
      FOR UPDATE;

      IF NOT FOUND OR v_op.reconciliation_status NOT IN ('OK', 'RECONCILED_NEW_RKO') THEN
        CONTINUE;
      END IF;

      UPDATE public.marketing_commission_operations
      SET voided_at = COALESCE(voided_at, NOW()),
          void_reason = 'РКО аннулирован в кассовом учёте (требуется сверка)',
          reconciliation_status = 'RECONCILIATION_REQUIRED'
      WHERE id = v_op.id;

      IF FOUND THEN
        v_voided_rko_ref := COALESCE(
          NULLIF(TRIM(NEW.reference), ''),
          CASE WHEN v_op.reconciled_rko_expense_id = NEW.id THEN v_op.reconciled_rko_reference ELSE v_op.rko_reference END,
          'РКО-' || NEW.id::TEXT
        );

        SELECT COALESCE(MAX(sequence_no), 0) + 1
        INTO v_next_seq
        FROM public.marketing_commission_rko_history
        WHERE payout_operation_id = v_op.id;

        INSERT INTO public.marketing_commission_rko_history (
          deal_id, payout_operation_id, sequence_no, event_type,
          rko_expense_id, rko_reference, previous_rko_expense_id, previous_rko_reference,
          status, reason, created_by, created_at
        ) VALUES (
          v_op.deal_id, v_op.id, v_next_seq, 'RKO_VOIDED',
          NEW.id, v_voided_rko_ref, NULL, NULL,
          'VOIDED_RECONCILIATION_REQUIRED',
          COALESCE(NULLIF(TRIM(NEW.void_reason), ''), 'РКО аннулирован в кассовом учёте'),
          NEW.voided_by,
          COALESCE(NEW.voided_at, NOW())
        );

        v_next_status := CASE
          WHEN v_comm.status = 'CANCELLED' THEN 'CANCELLED'
          ELSE 'RECONCILIATION_REQUIRED'
        END;

        -- Preserve paid_amount_minor! Only CONFIRM_PAYOUT_REFUND can reduce paid_amount_minor.
        UPDATE public.marketing_commissions
        SET status = v_next_status,
            reconciliation_required = TRUE,
            reconciliation_reason = 'РКО #' || NEW.id::TEXT || ' аннулирован в кассовом учёте; выплаченная сумма сохранена до подтверждения фактического возврата денег или привязки нового РКО',
            updated_at = NOW()
        WHERE deal_id = v_op.deal_id;

        INSERT INTO public.deal_audit_logs (deal_id, user_id, action, changes_json)
        VALUES (
          v_op.deal_id,
          NEW.voided_by,
          'UPDATE_COMMISSION_STATUS',
          jsonb_build_object(
            'action_type', 'RKO_VOIDED_RECONCILIATION_REQUIRED',
            'payout_operation_id', v_op.id,
            'rko_expense_id', NEW.id,
            'rko_reference', v_voided_rko_ref,
            'rko_history_sequence', v_next_seq,
            'preserved_paid_amount_minor', v_comm.paid_amount_minor,
            'paid_amount_minor', v_comm.paid_amount_minor,
            'status', v_next_status,
            'reconciliation_required', TRUE,
            'notes', 'Внимание администратору: РКО аннулирован в кассовом учёте. Сумма фактической выплаты сохранена; требуется сверка (CONFIRM_PAYOUT_REFUND или RECONCILE_PAYOUT_RKO).'
          )
        );
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_void_rko_linked_commission() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_void_rko_linked_commission() TO service_role, postgres;

CREATE TRIGGER trg_guard_void_rko_linked_commission
  AFTER UPDATE ON public.expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_void_rko_linked_commission();

COMMIT;
