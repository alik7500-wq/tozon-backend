# Tour 30 published — project 3 / unit 83

Object verified against database: ЖК TOZON PLAZA, Блок Б, unit number 7, area_m2_x100 8180. Tour 30 is now active and remains assigned only to UNIT 83 in project 3. Exactly five panorama rows remain (55–59), with Russian display names and deterministic sort order. The kitchen is panorama 58 with the new versioned object b70a9e04-e209-499f-8bf7-d09b23c34b9e_kitchen-v2.jpg. The original private kitchen file remains intact. The unlinked temporary import row 60 was removed after validating scope, upload checksum and absence of hotspots.

## Verification

- Graph: five reachable rooms, eight directed navigation links, zero missing reverse links; corridor<->living<->kitchen, corridor<->bedroom, corridor<->bathroom.
- All five private source files passed SHA-256, byte count and actual JPEG 8192x4096 dimension checks before public writes.
- Five public copies were uploaded without overwrites and downloaded anonymously by the server for SHA-256 checks. Server completion attestation: 2026-10-17T21:07:55.212Z. The exact attestation is retained in TOUR30_STORAGE_ATTESTATION.json.
- Independent downloads from all five public URLs also returned exact expected lengths and SHA-256 values.
- Activation was a separate guarded transaction with row locks, exact inactive tour/unit validation, exact unchanged hotspot snapshot, five current panorama paths and five verified public object metadata matches, and a 15-minute freshness condition. It activated exactly one tour at 2026-10-17 21:08:42.17921+00. The applied SQL is retained in TOUR30_ACTIVATION_APPLIED.sql; do not rerun it as a migration.
- Post-activation: is_active true; room_count 5; reachable_rooms 5; active_unit_tours 1; missing_reverse_edges 0.
- Unrelated data checksums before/after activation are identical: other tours 394cfc15b73ed3665a4a406421adb370; other panoramas 29f5410d0f6158d8e76444c9fe7c67b2; other hotspots 03d7547650f9a7aa01fdccc3e2304243.
- The frontend apartment button is wired to project_id 3 and initialTourId 30 through the exact UNIT assignment. Prior frontend PRs 15 and 16 and backend PR 10 were merged and deployed. UI selection/caption/form and isolation tests passed earlier.

## Operational release

Backend PR 12 merged as 232ac41f68a78ec9eba8737c3c7d5533e7f4e9f6. Staging deploy dep-db9u69aog99s739135gg became live. The one-time flag was then merged back to disabled without replacing any other environment variables. Disabled-configuration deploy dep-db9u7e3rjlhs7386gjs0 is live. No new HTTP endpoint, public credential, database schema or general publisher permission was added.

## Limits and rollback

The kitchen JPEG is resized from the image generator's 1774x887 output to 8192x4096; it is not native 8K detail. This limitation was disclosed before upload. Other four panoramas retain their original exact 8K bytes.

Projection QA inspected the kitchen return doorway and living room doorway views. Automated checks verify data, storage, runtime assets and component behavior; a full authenticated browser walkthrough in production could not be completed because the cloud browser session did not retain authentication. The owner should perform the final UI walkthrough in their normal working browser.

If visual QA finds an issue, unpublish only tour 30 using a guarded update. Do not delete original private objects. Original panorama/hotspot snapshots are retained in the earlier operation records.
