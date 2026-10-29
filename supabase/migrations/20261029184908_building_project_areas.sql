-- Project-document areas, distinct from sale inventory. Existing data stays NULL.
ALTER TABLE public.buildings
  ADD COLUMN IF NOT EXISTS footprint_area_m2_x100 integer
    CHECK (footprint_area_m2_x100 > 0),
  ADD COLUMN IF NOT EXISTS gross_floor_area_m2_x100 integer
    CHECK (gross_floor_area_m2_x100 > 0);

COMMENT ON COLUMN public.buildings.footprint_area_m2_x100 IS
  'Building footprint on the site in hundredths of a square metre; NULL means unknown.';
COMMENT ON COLUMN public.buildings.gross_floor_area_m2_x100 IS
  'Total floor area from design documentation in hundredths of a square metre; NULL means unknown.';
