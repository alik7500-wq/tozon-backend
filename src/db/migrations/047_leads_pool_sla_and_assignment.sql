-- Migration 047: Leads Pool, 15-Min SLA Control, and Assignment History (Sales Launch Phase 2)
-- Enables unified incoming leads pool, 15-minute first-contact SLA, and tracked assignments.
-- Safe, idempotent, non-destructive to existing leads.

BEGIN;

-- 1. Add SLA, assignment, and deduplication tracking columns to public.leads
ALTER TABLE public.leads 
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_contact_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_contact_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS first_contact_outcome VARCHAR(50),
  ADD COLUMN IF NOT EXISTS reassignment_reason TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);

-- 2. Indices for incoming pool, SLA queries, and deduplication
CREATE INDEX IF NOT EXISTS idx_leads_responsible_status ON public.leads(responsible_user_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_first_contact_at ON public.leads(first_contact_at);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_at ON public.leads(assigned_at);
CREATE INDEX IF NOT EXISTS idx_leads_idempotency_key ON public.leads(idempotency_key);

-- 3. Lead Assignment History Table (Audit Trail)
CREATE TABLE IF NOT EXISTS public.lead_assignment_history (
    id BIGSERIAL PRIMARY KEY,
    lead_id BIGINT NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
    from_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    to_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    assigned_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    assignment_type VARCHAR(50) NOT NULL DEFAULT 'MANUAL', -- 'MANUAL', 'ROUND_ROBIN', 'WEBHOOK_POOL'
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_assignment_lead_id ON public.lead_assignment_history(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_assignment_created_at ON public.lead_assignment_history(created_at);
CREATE INDEX IF NOT EXISTS idx_lead_assignment_to_user ON public.lead_assignment_history(to_user_id);

-- 4. RLS & Permissions
ALTER TABLE public.lead_assignment_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lead_assignment_history FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.lead_assignment_history_id_seq FROM PUBLIC, anon, authenticated;

GRANT ALL ON public.lead_assignment_history TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.lead_assignment_history_id_seq TO service_role;

DROP POLICY IF EXISTS lead_assignment_history_service_role ON public.lead_assignment_history;
CREATE POLICY lead_assignment_history_service_role ON public.lead_assignment_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
