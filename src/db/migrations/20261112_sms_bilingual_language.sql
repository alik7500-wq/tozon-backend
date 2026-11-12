-- Safe rollout: existing clients keep the previously used Russian SMS language.
-- Newly created clients default to Tajik. Existing historical SMS remain unknown.
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS sms_language text;
UPDATE public.leads SET sms_language = 'ru' WHERE sms_language IS NULL;
ALTER TABLE public.leads ALTER COLUMN sms_language SET DEFAULT 'tj';
ALTER TABLE public.leads ALTER COLUMN sms_language SET NOT NULL;
ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_sms_language_check;
ALTER TABLE public.leads ADD CONSTRAINT leads_sms_language_check CHECK (sms_language IN ('tj','ru'));

ALTER TABLE public.sms_messages ADD COLUMN IF NOT EXISTS language text;
ALTER TABLE public.sms_messages DROP CONSTRAINT IF EXISTS sms_messages_language_check;
ALTER TABLE public.sms_messages ADD CONSTRAINT sms_messages_language_check CHECK (language IS NULL OR language IN ('tj','ru'));

COMMENT ON COLUMN public.leads.sms_language IS 'Preferred SMS language: ru for legacy clients, tj for newly created clients.';
COMMENT ON COLUMN public.sms_messages.language IS 'Selected language of this SMS; NULL for historical unknown records.';
