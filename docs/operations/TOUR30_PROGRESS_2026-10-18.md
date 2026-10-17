# Tour 30 / unit 83 — navigation repair and publication status

Scope: Supabase yeslzrrcwgcqfxhgbrqk, project 3, unit 83, tour 30. Only this tour's hotspot rows changed. The original rows are retained in TOUR30_BEFORE_NAVIGATION_REPAIR.json. The applied transaction is retained in TOUR30_NAVIGATION_REPAIR.sql; it is a one-time repair, not a repeatable migration.

## Production navigation

- 55 corridor -> 56 bedroom (70), 57 living (71), 59 bathroom (72)
- 56 bedroom -> 55 corridor (69)
- 57 living -> 55 corridor (66), 58 kitchen (67)
- 58 kitchen -> 57 living (68), yaw 243 degrees, pitch -5 degrees
- 59 bathroom -> 55 corridor (64)

Hotspot 68 was relocated from the incorrect extra living-room link to the kitchen return doorway. Six rows were updated with guarded scope and exact row-count assertion, after the earlier single-row repair of hotspot 71. No hotspot rows were inserted or deleted.

Readback and recursive reachability query: reachable rooms 5; missing reverse edges 0; forbidden corridor<->kitchen edges 0; is_active false. Unrelated hotspot checksum unchanged: 03d7547650f9a7aa01fdccc3e2304243.

## Source-image evidence

TOZON_PLAZA_360_OFFLINE_CORS_FIXED.zip supplied the exact source bytes for all five production panoramas (embedded in index.html). All are 8192x4096. Their MD5 values match production Storage eTags:

- corridor: 901dac554bc7ed0feeb028f40f9d0ca2
- bedroom: 3df19ce428b94d92fbe85c03a5508b74
- living: 19ee2127a35b2e6f98990043985f3ca9
- kitchen original: f195b58c4f67d3f64429fff72b5e98ed
- bathroom: 9078a3c5e28c3f8701dae9e185fd8c76

A kitchen doorway image was generated from the exact kitchen source with living room as style reference. Native generator output was 1774x887, then Lanczos-resized to 8192x4096 JPEG (2:1). This is NOT native 8K detail. The limitation was disclosed to the owner. The original source remains intact.

Replacement candidate: kitchen-doorway-v2-8192x4096.jpg, 4,460,332 bytes, MD5 3957750172f612c84e9fe550c97e8603, SHA256 07d357bb2a226fe32b79a3d654939bffc79efc60470a542a59eef7394e6fb97a. Saved as a separate deliverable. It is NOT uploaded to production and panorama 58 still references its original image.

## Code releases

- Backend PR 10 merged as 4c002d6731ea69fe4dcb72e1fb381b2bb8670071; Render deploy dep-db9tgeu1egvs73d5gfqg live. /api/health returned ok with this exact SHA.
- Frontend PR 15 merged as 3beeb18d05e596b6a29e01d442d69908ff2129d3; live deployment confirmed; served JS confirmed explicit destination validation and correct projectId/initialTourId viewer props.
- Frontend PR 16 merged as 6f0f5b95f38f510b24250789f64e69f7ca087259; Render deploy dep-db9tmelg1s2s73aqdsog live. Fixes production hotspot label rendering and restricts an explicit apartment viewer to its own tour.
- Checks: first frontend change 10 tests + build; backend 15 tests; follow-up frontend 5 tests + build.

## Blockers / remaining release work

Browser CRM authentication appeared to succeed but data calls returned You are not logged in and reload returned to login. Manual user sign-in did not restore data access. No authentication code or browser security setting was changed.

Supabase Storage browser sign-in via ChatGPT did not result in a verified dashboard session. A user authentication handoff is needed before file upload/copy.

After authenticated Storage access:
1. Upload the kitchen candidate as a NEW versioned object under projects/3/360/30/ in the private draft bucket; preserve original. Verify bytes/checksum, then guarded update of panorama 58 path only.
2. Inspect all room transitions in an actual spherical viewer, including kitchen doorway angle and the image seam. Database graph checks do not replace visual QA.
3. Copy the five referenced verified files to panoramas-360 at their same paths; verify file sizes/checksums and public reads before activation.
4. In a transaction, recheck exact scope, graph, files and inactive state, then activate tour 30 only. Do not change any other tour or apartment.
5. Verify apartment 83 button and isolation from other units.

Tour 30 remains unpublished. Do not report image replacement or end-to-end visual verification as completed.
