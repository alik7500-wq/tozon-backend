ALTER TABLE public.layout_types ADD COLUMN IF NOT EXISTS gallery_images jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(gallery_images)='array');
ALTER TABLE public.layout_rooms ALTER COLUMN area DROP NOT NULL;
