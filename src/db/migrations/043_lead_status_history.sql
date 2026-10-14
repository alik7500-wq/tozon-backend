-- Migration 043: Lead Status History (Sales Automation V1.2)
-- Tracks lead pipeline stage transitions, responsible authors, and lost reasons.
-- Designed for future transitions without speculative historical backfill.
-- Strict Security: Zero public/anon/authenticated access. Internal service_role only.

BEGIN;

CREATE TABLE IF NOT EXISTS public.lead_status_history (
    id BIGSERIAL PRIMARY KEY,
    lead_id BIGINT NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
    from_status VARCHAR(50),
    to_status VARCHAR(50) NOT NULL,
    changed_by_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    lost_reason VARCHAR(100),
    comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indices for performance analytics and audit queries
CREATE INDEX IF NOT EXISTS idx_lead_status_history_lead_id ON public.lead_status_history(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_status_history_created_at ON public.lead_status_history(created_at);
CREATE INDEX IF NOT EXISTS idx_lead_status_history_to_status ON public.lead_status_history(to_status);
CREATE INDEX IF NOT EXISTS idx_lead_status_history_user ON public.lead_status_history(changed_by_user_id);

-- PostgreSQL Row Level Security (RLS) & Strict Role Permissions
ALTER TABLE public.lead_status_history ENABLE ROW LEVEL SECURITY;

-- Deny all direct access to public roles (anon and authenticated)
REVOKE ALL ON public.lead_status_history FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.lead_status_history_id_seq FROM PUBLIC, anon, authenticated;

-- Grant full access strictly to backend service_role
GRANT ALL ON public.lead_status_history TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.lead_status_history_id_seq TO service_role;

-- Policy ensuring service_role full control
DROP POLICY IF EXISTS lead_status_history_service_role ON public.lead_status_history;
CREATE POLICY lead_status_history_service_role ON public.lead_status_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
