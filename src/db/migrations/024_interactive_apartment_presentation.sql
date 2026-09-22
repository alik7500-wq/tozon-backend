-- ====================================================================
-- MIGRATION 024: Interactive Apartment Presentation Schema & Server-Only RLS
-- Safe Additive Migration for TOZON-CRM
-- ====================================================================

-- 1. EXTEND LAYOUT_TYPES
ALTER TABLE public.layout_types
    ADD COLUMN IF NOT EXISTS name_tg TEXT,
    ADD COLUMN IF NOT EXISTS description_ru TEXT,
    ADD COLUMN IF NOT EXISTS description_tg TEXT,
    ADD COLUMN IF NOT EXISTS furnished_plan_path TEXT,
    ADD COLUMN IF NOT EXISTS technical_plan_path TEXT,
    ADD COLUMN IF NOT EXISTS living_area NUMERIC CHECK (living_area IS NULL OR living_area > 0),
    ADD COLUMN IF NOT EXISTS kitchen_area NUMERIC CHECK (kitchen_area IS NULL OR kitchen_area > 0),
    ADD COLUMN IF NOT EXISTS ceiling_height NUMERIC CHECK (ceiling_height IS NULL OR ceiling_height > 0),
    ADD COLUMN IF NOT EXISTS bathrooms_count INTEGER CHECK (bathrooms_count IS NULL OR bathrooms_count >= 0),
    ADD COLUMN IF NOT EXISTS windows_count INTEGER CHECK (windows_count IS NULL OR windows_count >= 0),
    ADD COLUMN IF NOT EXISTS doors_count INTEGER CHECK (doors_count IS NULL OR doors_count >= 0),
    ADD COLUMN IF NOT EXISTS balconies_count INTEGER CHECK (balconies_count IS NULL OR balconies_count >= 0),
    ADD COLUMN IF NOT EXISTS heating_type_ru TEXT,
    ADD COLUMN IF NOT EXISTS heating_type_tg TEXT,
    ADD COLUMN IF NOT EXISTS ventilation_type_ru TEXT,
    ADD COLUMN IF NOT EXISTS ventilation_type_tg TEXT,
    ADD COLUMN IF NOT EXISTS orientation_ru TEXT,
    ADD COLUMN IF NOT EXISTS orientation_tg TEXT,
    ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT true;

-- 2. LAYOUT_ROOMS TABLE
CREATE TABLE IF NOT EXISTS public.layout_rooms (
    id SERIAL PRIMARY KEY,
    layout_type_id INTEGER NOT NULL REFERENCES public.layout_types(id) ON DELETE CASCADE,
    room_number INTEGER NOT NULL CHECK (room_number > 0),
    room_type TEXT NOT NULL DEFAULT 'ROOM',
    name_ru TEXT NOT NULL,
    name_tg TEXT,
    area NUMERIC NOT NULL CHECK (area > 0),
    description_ru TEXT,
    description_tg TEXT,
    floor_finish_ru TEXT,
    floor_finish_tg TEXT,
    wall_finish_ru TEXT,
    wall_finish_tg TEXT,
    ceiling_finish_ru TEXT,
    ceiling_finish_tg TEXT,
    lighting_ru TEXT,
    lighting_tg TEXT,
    ventilation_ru TEXT,
    ventilation_tg TEXT,
    position_x_percent NUMERIC NOT NULL CHECK (position_x_percent >= 0 AND position_x_percent <= 100),
    position_y_percent NUMERIC NOT NULL CHECK (position_y_percent >= 0 AND position_y_percent <= 100),
    polygon_points JSONB DEFAULT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CONSTRAINT uq_layout_room_number UNIQUE (layout_type_id, room_number)
);

CREATE INDEX IF NOT EXISTS idx_layout_rooms_layout ON public.layout_rooms(layout_type_id);
CREATE INDEX IF NOT EXISTS idx_layout_rooms_sort ON public.layout_rooms(layout_type_id, sort_order, room_number);

-- 3. LAYOUT_FEATURES TABLE
CREATE TABLE IF NOT EXISTS public.layout_features (
    id SERIAL PRIMARY KEY,
    layout_type_id INTEGER NOT NULL REFERENCES public.layout_types(id) ON DELETE CASCADE,
    icon_key TEXT NOT NULL DEFAULT 'Sparkles',
    text_ru TEXT NOT NULL,
    text_tg TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_layout_features_layout ON public.layout_features(layout_type_id);
CREATE INDEX IF NOT EXISTS idx_layout_features_sort ON public.layout_features(layout_type_id, sort_order);

-- 4. HARDEN PERMISSIONS: SERVER-ONLY MODEL
-- Direct Data API access from client (anon and authenticated) is completely REVOKED.
REVOKE ALL ON public.layout_rooms FROM anon;
REVOKE ALL ON public.layout_rooms FROM authenticated;
GRANT ALL ON public.layout_rooms TO service_role;

REVOKE ALL ON public.layout_features FROM anon;
REVOKE ALL ON public.layout_features FROM authenticated;
GRANT ALL ON public.layout_features TO service_role;

-- 5. ENABLE ROW LEVEL SECURITY AND DROP ALL PERMISSIVE CLIENT POLICIES
ALTER TABLE public.layout_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.layout_features ENABLE ROW LEVEL SECURITY;

-- Drop legacy/permissive policies if present
DROP POLICY IF EXISTS layout_rooms_select_policy ON public.layout_rooms;
DROP POLICY IF EXISTS layout_features_select_policy ON public.layout_features;
DROP POLICY IF EXISTS layout_rooms_all_policy ON public.layout_rooms;
DROP POLICY IF EXISTS layout_features_all_policy ON public.layout_features;
DROP POLICY IF EXISTS layout_rooms_project_select ON public.layout_rooms;
DROP POLICY IF EXISTS layout_features_project_select ON public.layout_features;
DROP POLICY IF EXISTS layout_rooms_admin_modify ON public.layout_rooms;
DROP POLICY IF EXISTS layout_features_admin_modify ON public.layout_features;

-- Service role bypasses RLS for Express Backend operations while table RLS blocks direct client API access.
