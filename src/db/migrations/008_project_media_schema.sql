-- ====================================================================
-- MIGRATION 008: Project Visual Media Gallery
-- Safe Additive Migration for TOZON-CRM
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.project_media (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK(category IN ('EXTERIOR', 'COURTYARD', 'MASTERPLAN', 'ENTRANCE', 'INTERIOR', 'FLOOR_PLAN', 'COMMERCIAL', 'CONSTRUCTION', 'OTHER')),
    title TEXT NOT NULL,
    description TEXT,
    storage_path TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_cover BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_media_project ON public.project_media(project_id);
CREATE INDEX IF NOT EXISTS idx_project_media_category ON public.project_media(project_id, category);
CREATE INDEX IF NOT EXISTS idx_project_media_sort ON public.project_media(project_id, sort_order);

-- Unique index to enforce at most one cover image per project
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_cover 
ON public.project_media(project_id) 
WHERE is_cover = true;
