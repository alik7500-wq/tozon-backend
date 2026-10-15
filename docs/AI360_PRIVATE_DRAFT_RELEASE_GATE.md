# TOZON CRM — Private 360 Draft Bucket Deployment Gate

**Status: code-only prototype, NOT deployed.**

## Required production prerequisites (not performed)

1. Create Supabase Storage bucket `panoramas-360-drafts` with `public=false`, 50 MiB file limit, allowed MIME types image/jpeg and image/webp. Do not reuse the current public `panoramas-360` bucket for drafts.
2. Confirm backend `SUPABASE_SERVICE_ROLE_KEY` is configured. Never send this key to the browser.
3. Audit and restrict the shared permissive storage policy `Allow All Visual Storage Objects` before treating draft access as secure; verify that no other permissive policy grants anonymous writes to the new bucket.
4. Ensure draft reads are admin/director-only. **Current GET routes are authenticated but do not enforce admin/director or draft ownership; this must be fixed before deployment.**
5. Existing published tour 24 and panorama rows 53/54 must remain on `panoramas-360` unchanged.
6. **Publishing requires moving/copying draft files from `panoramas-360-drafts` to `panoramas-360` and updating paths atomically (or storing a bucket field per panorama).** The current schema stores only storage_path. Never activate a draft until that workflow is implemented.
7. Test signed upload using a dedicated test project, then verify read, denial for unauthenticated users, and no regression to published tour.

## Current code restrictions

The draft upload endpoint requires a tourId, checks its project and rejects active tours. Signed upload and read URL creation uses service-role credentials. This is a foundation only, not a complete release. The existing `getPanoramas` and `createPanorama` read paths still assume the published bucket and need alignment before release.

No production database, storage or deployment changes were made.
