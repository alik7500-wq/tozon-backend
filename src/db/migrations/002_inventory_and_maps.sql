CREATE TABLE IF NOT EXISTS buildings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE(project_id, code)
);

CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE(building_id, code)
);

CREATE TABLE IF NOT EXISTS floors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
    floor_number INTEGER NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE(section_id, floor_number)
);

CREATE TABLE IF NOT EXISTS layout_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    rooms INTEGER NOT NULL CHECK(rooms >= 0),
    area_m2_x100 INTEGER NOT NULL CHECK(area_m2_x100 > 0),
    default_price_per_m2_minor INTEGER NOT NULL DEFAULT 0 CHECK(default_price_per_m2_minor >= 0),
    image_path TEXT,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE(project_id, code)
);

CREATE TABLE IF NOT EXISTS units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    floor_id INTEGER NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
    layout_type_id INTEGER REFERENCES layout_types(id) ON DELETE SET NULL,
    unit_number TEXT NOT NULL,
    position_on_floor INTEGER NOT NULL DEFAULT 1,
    rooms INTEGER NOT NULL CHECK(rooms >= 0),
    area_m2_x100 INTEGER NOT NULL CHECK(area_m2_x100 > 0),
    price_per_m2_minor INTEGER NOT NULL CHECK(price_per_m2_minor >= 0),
    manual_total_price_minor INTEGER,
    status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK(status IN ('AVAILABLE', 'RESERVED', 'SOLD', 'BLOCKED')),
    block_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    UNIQUE(floor_id, unit_number)
);

CREATE TABLE IF NOT EXISTS visual_maps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    building_id INTEGER REFERENCES buildings(id) ON DELETE CASCADE,
    section_id INTEGER REFERENCES sections(id) ON DELETE CASCADE,
    floor_id INTEGER REFERENCES floors(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('GENPLAN', 'FACADE', 'FLOORPLAN')),
    title TEXT NOT NULL,
    image_path TEXT NOT NULL,
    image_width INTEGER,
    image_height INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS map_hotspots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visual_map_id INTEGER NOT NULL REFERENCES visual_maps(id) ON DELETE CASCADE,
    target_building_id INTEGER REFERENCES buildings(id) ON DELETE CASCADE,
    target_section_id INTEGER REFERENCES sections(id) ON DELETE CASCADE,
    target_floor_id INTEGER REFERENCES floors(id) ON DELETE CASCADE,
    target_unit_id INTEGER REFERENCES units(id) ON DELETE CASCADE,
    x_pct REAL NOT NULL CHECK(x_pct >= 0 AND x_pct <= 100),
    y_pct REAL NOT NULL CHECK(y_pct >= 0 AND y_pct <= 100),
    width_pct REAL NOT NULL CHECK(width_pct > 0 AND width_pct <= 100),
    height_pct REAL NOT NULL CHECK(height_pct > 0 AND height_pct <= 100),
    label TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(x_pct + width_pct <= 100),
    CHECK(y_pct + height_pct <= 100)
);

-- Indexes for fast queries and chessboard rendering
CREATE INDEX IF NOT EXISTS idx_buildings_project ON buildings(project_id);
CREATE INDEX IF NOT EXISTS idx_sections_building ON sections(building_id);
CREATE INDEX IF NOT EXISTS idx_floors_section ON floors(section_id);
CREATE INDEX IF NOT EXISTS idx_units_floor ON units(floor_id);
CREATE INDEX IF NOT EXISTS idx_units_status ON units(status);
CREATE INDEX IF NOT EXISTS idx_layout_types_project ON layout_types(project_id);
CREATE INDEX IF NOT EXISTS idx_visual_maps_project ON visual_maps(project_id);
CREATE INDEX IF NOT EXISTS idx_map_hotspots_map ON map_hotspots(visual_map_id);
