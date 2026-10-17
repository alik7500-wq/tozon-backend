# Bounded storage staging for tour 30

The owner requested publication of tour 30 (project 3, unit 83). Browser file access is blocked by unsuccessful dashboard authentication. This release provides a server-side operational task using the backend's existing service-role access. It exposes no new HTTP endpoint or credential.

The task is disabled unless TOZON_TOUR30_STAGE_ONCE equals approved-2026-10-18. It runs after the HTTP listener starts and never changes tour activation or database rows. It checks the exact inactive tour/unit, five panorama IDs and versioned paths, eight expected navigation edges, source byte counts, SHA-256 values and 8192x4096 JPEG headers. All sources are checked before any public write. Each file is rechecked immediately before its copy. Every copy uses upsert:false; existing objects are anonymously downloaded and verified instead of overwritten. Context is rechecked before each file and after all files.

Only five fixed paths under projects/3/360/30/ may be copied from panoramas-360-drafts to panoramas-360. The original private files remain. Failures leave the tour inactive and do not block the API listener. Partial staging is safe to retry: matching public objects are reused; mismatches fail without overwrite. Logs contain hashes, paths, dimensions and sizes, never credentials.

The uploaded kitchen-v2 source matched 4,460,332 bytes and MD5 3957750172f612c84e9fe550c97e8603. Panorama 58 was rebound to the new object in a guarded transaction. The temporary import panorama 60, which had no incoming or outgoing hotspots, was removed from the tour; the image object remains. Exactly five room records remain. Original kitchen source is preserved.

Run checks: vitest stageTour30.test.js and ai360Dimensions.test.js (19 passing tests).

After TOUR30_STORAGE_STAGE_VERIFIED appears: disable the one-time flag by setting it to disabled, deploy the disabled configuration, independently verify the five public files and current navigation, then use a separate guarded transaction to activate only tour 30. Never treat the task's startup or a live Render status as evidence of completed staging. The generated kitchen candidate was resized from 1774x887 to 8192x4096; that resolution limitation was disclosed to the owner.
