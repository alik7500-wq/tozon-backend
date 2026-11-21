# Stage 13 — administrative private storage self-test

The isolated pilot administrator can now run `POST /api/company-projects/:id/storage-check` from ProjectReadiness. It creates the existing private bucket lazily, uploads a small synthetic PDF to a random project/_diagnostics path, downloads and checks SHA-256, probes public and authenticated Storage paths without credentials, deletes only its own random object and verifies it is gone. The endpoint never reads a contract, impersonates a member, grants access, registers a business attachment or changes a financial record.

Controls: current ADMIN/settings/users permission gate, exact test database runtime guard, existing project authorization checked three times, all document/files/write flags, same-origin cookie protection, strict empty body/query, UUID project ID, per-actor rate limit 5/minute, fixed Storage origin, redirect denial and 10-second anonymous-probe timeouts. Cleanup runs even after uncertain upload, download failure, corruption or detected public exposure. Cleanup failure cannot produce success. The browser refreshes readiness only after a successful storage check; old project responses are discarded.

The first real browser probe exposed Storage's HTTP 400 with semantic string statusCode "404" for a missing bucket. Lazy creation now recognizes that response, including concurrent creation's semantic 409. The pilot error handler normalizes string HTTP codes before passing them to Express and hides server errors. Storage diagnostics use authenticated actor rate-limit keys instead of trusting forwarded client-IP headers.

## Verified 2026-11-12

- Backend deployed commit cc9df63884176975740517408b5eddff69d10324, Render deploy dep-dbr00t4ipgvc73cvrucg live.
- Frontend deployed commit 60295cf15075be9b5fab83b0b1f97b27d05cee53, deploy dep-dbqvv6rtqb8s739i7mpg live.
- Real administrative browser check on Plaza succeeded: upload, download, byte/hash integrity, anonymous denial on both paths, deletion and read-after-delete denial.
- SQL verified bucket company-project-private has public=false, 10 MiB limit and PDF/JPEG/PNG MIME allowlist. Existing restrictive Storage policy still denies browser-role access to this bucket.
- Post-check bucket objects=0 and registered attachments=0. Business counts unchanged: users=2, deals=1, payments=0, expenses=0. Rights and planned memberships unchanged.
- Plaza readiness revision 5: template gaps=0, private bucket exists/private=true, every technical checklist item PASS; manual validation remains REVIEW and production_ready remains false.
- 224 backend tests in 27 files, 28 targeted frontend tests in 6 files, production frontend build and changed-file oxlint passed.
- Browser proof: docs/qa/company-project-storage-check.jpg.

## Practical limits

This is an administrator's real Storage transport test, not an end-to-end employee attachment upload or a new signed-contract printing test. The employee password was not read or reset; no employee was impersonated. The pre-existing signed demonstration contract still has no frozen signer, and Word correctly remains blocked for that contract. No new contracts or receipts were created. Production services/database and external sends were not changed. No permission was auto-granted and no production launch was performed.
