-- =============================================================================
-- Migration 066: Real Authoritative User-to-Project Access Scope (R04.2)
-- Description:
--   Adds persisted user project access model without auto-granting global access
--   to existing managers or directors:
--     1. public.users.all_projects_access BOOLEAN NOT NULL DEFAULT FALSE
--     2. public.user_project_access (user_id, project_id, can_view)
--   Existing users remain fail-closed (all_projects_access = FALSE) until
--   explicitly granted global access or project rows via admin API/migration.
-- =============================================================================

BEGIN;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS all_projects_access BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS public.user_project_access (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    project_id BIGINT NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    can_view BOOLEAN NOT NULL DEFAULT TRUE,
    created_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_project_access UNIQUE (user_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_user_project_access_user_id
    ON public.user_project_access(user_id);

CREATE INDEX IF NOT EXISTS idx_user_project_access_project_id
    ON public.user_project_access(project_id);

ALTER TABLE public.user_project_access ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_all_user_project_access ON public.user_project_access;
CREATE POLICY service_role_all_user_project_access ON public.user_project_access
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

REVOKE ALL ON TABLE public.user_project_access FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_project_access TO service_role;

COMMIT;
