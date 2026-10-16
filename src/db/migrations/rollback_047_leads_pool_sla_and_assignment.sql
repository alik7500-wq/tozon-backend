-- Rollback for Migration 047: Leads Pool, 15-Min SLA Control, and Assignment History
BEGIN;

DROP TABLE IF EXISTS public.lead_assignment_history CASCADE;

DROP INDEX IF EXISTS public.idx_leads_responsible_status;
DROP INDEX IF EXISTS public.idx_leads_first_contact_at;
DROP INDEX IF EXISTS public.idx_leads_assigned_at;
DROP INDEX IF EXISTS public.idx_leads_idempotency_key;

ALTER TABLE public.leads
  DROP COLUMN IF EXISTS assigned_at,
  DROP COLUMN IF EXISTS first_contact_at,
  DROP COLUMN IF EXISTS first_contact_by_user_id,
  DROP COLUMN IF EXISTS first_contact_outcome,
  DROP COLUMN IF EXISTS reassignment_reason,
  DROP COLUMN IF EXISTS idempotency_key;

COMMIT;
