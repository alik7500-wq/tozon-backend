-- One statement provides a consistent snapshot and avoids PostgREST row limits.
-- No buyer identities, phone numbers, passports, or contracts are fetched.
CREATE OR REPLACE FUNCTION public.telegram_finance_snapshot() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
SELECT jsonb_build_object(
  'payments', COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM (
    SELECT id, deal_id, amount_minor, currency, payment_date, settlement_method, reference,
      comment, created_at, status, voided_at, transfer_id, conversion_id, cash_desk_id, operation_type
    FROM public.payments
  ) p), '[]'::jsonb),
  'expenses', COALESCE((SELECT jsonb_agg(to_jsonb(e)) FROM (
    SELECT id, amount_minor, currency, expense_date, settlement_method, reference, category,
      description, created_at, status, voided_at, transfer_id, conversion_id, conversion_expense_id, cash_desk_id, operation_type, amount_tjs, amount_usd, exchange_rate
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
