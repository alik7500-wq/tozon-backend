-- Server-only reporting bot. No financial records are modified.
CREATE TABLE public.telegram_finance_subscribers (
  telegram_id text PRIMARY KEY CHECK (telegram_id ~ '^[1-9][0-9]{0,15}$'),
  display_name text NOT NULL DEFAULT '',
  username text NOT NULL DEFAULT '',
  slot text UNIQUE CHECK (slot IN ('AKMALKHON','ILHOM','ASRORKHON','MUBINCHON')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REVOKED')),
  approved_by bigint,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'APPROVED' AND slot IS NOT NULL) OR (status <> 'APPROVED' AND slot IS NULL))
);
CREATE TABLE public.telegram_finance_state (
  id integer PRIMARY KEY CHECK (id = 1),
  update_offset bigint NOT NULL DEFAULT 0,
  worker_id uuid,
  lease_until timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO public.telegram_finance_state(id) VALUES (1);
CREATE TABLE public.telegram_finance_deliveries (
  telegram_id text NOT NULL REFERENCES public.telegram_finance_subscribers(telegram_id),
  report_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('PROCESSING','SENT','UNKNOWN')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (telegram_id, report_date)
);
CREATE TABLE public.telegram_finance_updates (
  update_id bigint PRIMARY KEY,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','DONE')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX telegram_finance_updates_pending ON public.telegram_finance_updates(update_id) WHERE status = 'PENDING';
ALTER TABLE public.telegram_finance_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_finance_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_finance_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_finance_updates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_finance_subscribers, public.telegram_finance_state, public.telegram_finance_deliveries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.telegram_finance_subscribers, public.telegram_finance_state, public.telegram_finance_deliveries TO service_role;
REVOKE ALL ON public.telegram_finance_updates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.telegram_finance_updates TO service_role;

CREATE FUNCTION public.telegram_finance_claim_worker(p_worker uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
  WITH claimed AS (
    UPDATE public.telegram_finance_state
    SET worker_id = p_worker, lease_until = now() + interval '180 seconds'
    WHERE id = 1 AND (lease_until < now() OR worker_id = p_worker)
    RETURNING id
  ) SELECT EXISTS (SELECT 1 FROM claimed);
$$;
REVOKE ALL ON FUNCTION public.telegram_finance_claim_worker(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.telegram_finance_claim_worker(uuid) TO service_role;

-- One statement provides a consistent snapshot and avoids PostgREST row limits.
-- No buyer identities, phone numbers, passports, or contracts are fetched.
CREATE FUNCTION public.telegram_finance_snapshot() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
SELECT jsonb_build_object(
  'payments', COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM (
    SELECT id, deal_id, amount_minor, currency, payment_date, settlement_method, reference,
      comment, created_at, status, voided_at, transfer_id, conversion_id, cash_desk_id, operation_type
    FROM public.payments
  ) p), '[]'::jsonb),
  'expenses', COALESCE((SELECT jsonb_agg(to_jsonb(e)) FROM (
    SELECT id, amount_minor, currency, expense_date, settlement_method, reference, category,
      description, created_at, status, voided_at, transfer_id, conversion_id, conversion_expense_id, cash_desk_id, operation_type
    FROM public.expenses
  ) e), '[]'::jsonb),
  'deals', COALESCE((SELECT jsonb_agg(to_jsonb(d)) FROM (
    SELECT d.id, d.status, d.currency, d.final_price_minor, d.signed_at, d.deal_date, d.created_at, u.area_m2_x100
    FROM public.deals d LEFT JOIN public.units u ON u.id = d.unit_id
  ) d), '[]'::jsonb),
  'desks', COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM (
    SELECT id, name, code FROM public.dictionaries WHERE type = 'CASH_DESK' AND is_active = true ORDER BY sort_order, name
  ) c), '[]'::jsonb)
);
$$;
REVOKE ALL ON FUNCTION public.telegram_finance_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.telegram_finance_snapshot() TO service_role;
