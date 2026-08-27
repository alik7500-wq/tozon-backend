-- ====================================================================
-- MIGRATION 007: Visual 3D & 360° Data Layer
-- Safe Additive Migration for TOZON-CRM
-- ====================================================================

-- 1. SCENE_3D (3D Models & Metadata)
CREATE TABLE IF NOT EXISTS public.scene_3d (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    building_id INTEGER REFERENCES public.buildings(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    scene_type TEXT NOT NULL CHECK(scene_type IN ('MASTERPLAN', 'BUILDING', 'FLOOR', 'APARTMENT')),
    storage_path TEXT NOT NULL,
    file_size_bytes BIGINT DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT true,
    camera_config JSONB NOT NULL DEFAULT '{"position": [30, 20, 30], "target": [0, 0, 0], "fov": 45}'::jsonb,
    environment_config JSONB NOT NULL DEFAULT '{"preset": "city", "exposure": 1.0, "background_color": "#0f172a"}'::jsonb,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Index to ensure fast queries by project and active status
CREATE INDEX IF NOT EXISTS idx_scene_3d_project ON public.scene_3d(project_id);
CREATE INDEX IF NOT EXISTS idx_scene_3d_active ON public.scene_3d(is_active);
CREATE INDEX IF NOT EXISTS idx_scene_3d_building ON public.scene_3d(building_id);

-- Unique index to guarantee at most one active scene of a given type per building/masterplan
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_scene 
ON public.scene_3d (project_id, COALESCE(building_id, -1), scene_type) 
WHERE is_active = true;


-- 2. SCENE_3D_ENTITIES (Mesh to CRM Entity Mapping)
CREATE TABLE IF NOT EXISTS public.scene_3d_entities (
    id SERIAL PRIMARY KEY,
    scene_id INTEGER NOT NULL REFERENCES public.scene_3d(id) ON DELETE CASCADE,
    mesh_key TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('BUILDING', 'SECTION', 'FLOOR', 'UNIT', 'POI')),
    entity_id INTEGER NOT NULL,
    interaction_type TEXT NOT NULL DEFAULT 'SELECT' CHECK(interaction_type IN ('SELECT', 'HOVER_INFO', 'FOCUS', 'NONE')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CONSTRAINT uq_scene_mesh UNIQUE (scene_id, mesh_key)
);

CREATE INDEX IF NOT EXISTS idx_scene_entities_scene ON public.scene_3d_entities(scene_id);
CREATE INDEX IF NOT EXISTS idx_scene_entities_mesh ON public.scene_3d_entities(mesh_key);
CREATE INDEX IF NOT EXISTS idx_scene_entities_lookup ON public.scene_3d_entities(entity_type, entity_id);


-- 3. TOURS_360 (Virtual Tours)
CREATE TABLE IF NOT EXISTS public.tours_360 (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    tour_type TEXT NOT NULL CHECK(tour_type IN ('PROJECT', 'BUILDING', 'FLOOR', 'UNIT', 'SHOWROOM', 'COURTYARD')),
    entity_type TEXT CHECK(entity_type IS NULL OR entity_type IN ('BUILDING', 'SECTION', 'FLOOR', 'UNIT', 'POI')),
    entity_id INTEGER,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tours_360_project ON public.tours_360(project_id);
CREATE INDEX IF NOT EXISTS idx_tours_360_entity ON public.tours_360(entity_type, entity_id);


-- 4. PANORAMA_360 (Equirectangular 2:1 Panorama Spheres)
CREATE TABLE IF NOT EXISTS public.panorama_360 (
    id SERIAL PRIMARY KEY,
    tour_id INTEGER NOT NULL REFERENCES public.tours_360(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    thumbnail_path TEXT,
    entity_type TEXT CHECK(entity_type IS NULL OR entity_type IN ('BUILDING', 'SECTION', 'FLOOR', 'UNIT', 'POI')),
    entity_id INTEGER,
    initial_yaw NUMERIC NOT NULL DEFAULT 0,
    initial_pitch NUMERIC NOT NULL DEFAULT 0,
    initial_fov NUMERIC NOT NULL DEFAULT 75,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_panorama_360_tour ON public.panorama_360(tour_id);
CREATE INDEX IF NOT EXISTS idx_panorama_360_sort ON public.panorama_360(tour_id, sort_order);


-- 5. PANORAMA_HOTSPOTS (Navigation and Info Markers)
CREATE TABLE IF NOT EXISTS public.panorama_hotspots (
    id SERIAL PRIMARY KEY,
    panorama_id INTEGER NOT NULL REFERENCES public.panorama_360(id) ON DELETE CASCADE,
    hotspot_type TEXT NOT NULL CHECK(hotspot_type IN ('NAVIGATION', 'UNIT', 'INFO', 'BUILDING', 'FLOOR', 'EXIT')),
    yaw NUMERIC NOT NULL,
    pitch NUMERIC NOT NULL,
    label TEXT,
    target_panorama_id INTEGER REFERENCES public.panorama_360(id) ON DELETE SET NULL,
    target_entity_type TEXT CHECK(target_entity_type IS NULL OR target_entity_type IN ('BUILDING', 'SECTION', 'FLOOR', 'UNIT', 'POI')),
    target_entity_id INTEGER,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hotspots_panorama ON public.panorama_hotspots(panorama_id);
CREATE INDEX IF NOT EXISTS idx_hotspots_target_pano ON public.panorama_hotspots(target_panorama_id);
