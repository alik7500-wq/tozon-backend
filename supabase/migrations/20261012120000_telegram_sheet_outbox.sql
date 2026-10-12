CREATE TABLE public.telegram_finance_sheet_outbox (
 id uuid PRIMARY KEY REFERENCES public.telegram_finance_expense_drafts(id),
 cash_desk_id uuid NOT NULL,
 payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENT','UNMAPPED')),
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz
);
ALTER TABLE public.telegram_finance_sheet_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_finance_sheet_outbox FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.telegram_finance_sheet_outbox TO service_role;
CREATE FUNCTION public.telegram_finance_queue_sheet() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.status='POSTED' AND OLD.status IS DISTINCT FROM 'POSTED' THEN
  INSERT INTO public.telegram_finance_sheet_outbox(id,cash_desk_id,payload)
  VALUES(NEW.id,NEW.cash_desk_id,NEW.payload || jsonb_build_object('reference',NEW.result->>'reference','debit_currency',NEW.result->>'currency','debit_amount',NEW.result->'amount'))
  ON CONFLICT(id) DO NOTHING;
 END IF;
 RETURN NEW;
END;$$;
REVOKE ALL ON FUNCTION public.telegram_finance_queue_sheet() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER telegram_finance_queue_sheet AFTER UPDATE OF status ON public.telegram_finance_expense_drafts FOR EACH ROW EXECUTE FUNCTION public.telegram_finance_queue_sheet();
