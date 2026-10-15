-- READ-ONLY production preflight for 360 draft storage.
-- PASS only when the draft bucket exists, is private, and has no broad read/write policy.
WITH bucket AS (
  SELECT id, public, file_size_limit, allowed_mime_types
  FROM storage.buckets WHERE id = 'panoramas-360-drafts'
), dangerous_policies AS (
  SELECT policyname, cmd, roles::text AS roles, qual, with_check
  FROM pg_policies
  WHERE schemaname = 'storage' AND tablename = 'objects'
    AND (roles && ARRAY['public','anon','authenticated']::name[])
    AND (
      (coalesce(qual,'') ILIKE '%panoramas-360-drafts%')
      OR (coalesce(with_check,'') ILIKE '%panoramas-360-drafts%')
      OR (coalesce(qual,'') = 'true')
      OR (coalesce(with_check,'') = 'true')
      OR (qual IS NULL AND with_check IS NULL)
    )
)
SELECT
  EXISTS(SELECT 1 FROM bucket) AS bucket_exists,
  (SELECT NOT public FROM bucket) AS bucket_private,
  (SELECT file_size_limit FROM bucket) AS file_size_limit,
  (SELECT allowed_mime_types FROM bucket) AS allowed_mime_types,
  (SELECT count(*) FROM dangerous_policies) AS broad_policy_candidates,
  (SELECT coalesce(jsonb_agg(to_jsonb(dangerous_policies)), '[]'::jsonb) FROM dangerous_policies) AS policies_to_review;
-- IMPORTANT: SQL text matching is only a preliminary screen. Review ALL storage policies
-- and any inherited grants/functions before asserting production security.
-- Do not use this query to authorize automatic publishing or uploading.
