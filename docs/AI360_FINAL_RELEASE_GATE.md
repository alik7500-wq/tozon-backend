# TOZON PLAZA — AI 360 final release decision

Status: **NOT READY FOR PRODUCTION**. This is a consolidated release gate, not a deployment instruction.

## Scope
Pilot: Block A, layout type 6 (81.18 m²), furnished-plan reference PDF20251016-A-6. Five scenes: living room, bedroom, kitchen, bathroom, corridor. Contemporary comfort. Panoramas must be equirectangular 2:1, inspected for geometry, room consistency and seams. The furnished floor plan is the layout source; AI output must not be represented as architecturally exact without human verification.

## Already staged
Frontend draft PR #8: viewer error fallback, layout-editor panorama preview and upload flow. Backend draft PR #8: draft guards, private-bucket URL generation, publish manifest, read-only checksum checks, copy/journal/recovery prototypes. Neither PR is merged or deployed.

## Release blockers — resolve together, not piecemeal
1. **Real AI provider:** choose/configure authorized image-to-panorama pipeline, secure API credentials, costs/quotas, reference-image rights and user consent; implement job queue and status/errors. No provider is connected yet.
2. **Storage policy:** create PRIVATE `panoramas-360-drafts` bucket; restrict `storage.objects` permissions for drafts and published `panoramas-360` (current broad public policy is unsafe for writes). Keep existing published objects readable and intact.
3. **Publication:** install reviewed service-only journal; durable per-file ownership and SHA-256 attestations, immutable object versions, trusted transition to ACTIVATING, transactional DB activation, idempotent retry and crash recovery. SQL activation proposal is intentionally disabled until these guarantees exist.
4. **Authorization and integrity:** enforce roles on all draft read/write routes, prevent editing published tours or mutation during publish; protect hotspot visibility and avoid cross-project access.
5. **End-to-end pilot:** generate five scenes from real furnished plan, review images in browser and on mobile, upload to private bucket, verify scene navigation, run failure/retry/security tests, publish one *new* test tour only after sign-off.
6. **Release:** green frontend/backend CI, real Supabase integration test, browser test, rollback plan, merge and deploy in a coordinated window, smoke-test production. Do not touch existing active showroom tour 24 or panoramas 53/54.

## Acceptance criteria
A non-admin cannot see or change drafts; admin can create and review a five-room draft; no client can activate via generic PATCH; publish verifies each file and atomically activates exactly once; failed/interrupted jobs never auto-delete unowned objects or auto-activate; existing tours remain functional; customer can rotate all five panoramas and navigate between rooms on desktop and mobile.

## Operational decision
**No production changes and no AI charges until blockers are closed and evidence recorded.** Draft PRs are a foundation, not a completed AI 360 generator.
