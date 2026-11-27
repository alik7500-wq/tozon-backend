BEGIN;
-- Legacy Plaza-2 parking is sold per space and has no recorded area.
-- Preserve NULL only for parking; retain the existing positive-area check.
ALTER TABLE public.units ALTER COLUMN area_m2_x100 DROP NOT NULL;
ALTER TABLE public.units ADD CONSTRAINT units_area_required_except_parking
 CHECK (unit_kind='PARKING' OR area_m2_x100 IS NOT NULL);
COMMIT;
