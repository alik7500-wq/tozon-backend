-- PROPOSAL ONLY: review and apply separately after explicit production approval.
-- Creates an isolated private storage bucket for unpublished 360 panoramas.
-- Does not modify existing public buckets, policies, objects, or tours.
DO $$
DECLARE
  existing storage.buckets%ROWTYPE;
BEGIN
  SELECT * INTO existing FROM storage.buckets WHERE id = 'panoramas-360-drafts';
  IF FOUND THEN
    IF existing.public IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'panoramas-360-drafts already exists but is PUBLIC; refusing silent modification';
    END IF;
    RAISE NOTICE 'Private drafts bucket already exists; leaving its configuration unchanged';
  ELSE
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('panoramas-360-drafts', 'panoramas-360-drafts', false, 52428800, ARRAY['image/jpeg','image/webp']);
  END IF;
END $$;

-- SECURITY AUDIT REQUIRED BEFORE RELEASE:
-- 1. Verify no public/anon/authenticated policy grants read/write to drafts.
-- 2. Confirm service-role backend generates signed URLs only for ADMIN/DIRECTOR.
-- 3. Existing 'Allow All Visual Storage Objects' policy currently excludes this bucket.
-- 4. Do not change the existing panoramas-360 public bucket or published tour rows.
-- 5. Do not activate drafts: safe atomic publish is not deployed.
SELECT id, public, file_size_limit, allowed_mime_types
FROM storage.buckets WHERE id = 'panoramas-360-drafts';
