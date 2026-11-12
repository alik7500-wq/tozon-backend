-- Staged only: apply before deploying bilingual SMS backend/frontend.
-- Historical SMS languages are unknown and must not be backfilled as Tajik.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS sms_language text NOT NULL DEFAULT 'tj';
ALTER TABLE public.leads
  DROP CONSTRAINT IF EXISTS leads_sms_language_check;
ALTER TABLE public.leads
  ADD CONSTRAINT leads_sms_language_check CHECK (sms_language IN ('tj','ru'));

ALTER TABLE public.sms_messages
  ADD COLUMN IF NOT EXISTS language text;
ALTER TABLE public.sms_messages
  DROP CONSTRAINT IF EXISTS sms_messages_language_check;
ALTER TABLE public.sms_messages
  ADD CONSTRAINT sms_messages_language_check CHECK (language IS NULL OR language IN ('tj','ru'));

COMMENT ON COLUMN public.leads.sms_language IS 'Preferred outgoing SMS language: tj (default) or ru.';
COMMENT ON COLUMN public.sms_messages.language IS 'Language selected for this SMS. NULL for historical/unknown messages.';
