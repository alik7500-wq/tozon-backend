# Skybox AI integration — controlled pilot (TOZON CRM)

The frontend and backend changes are staged in draft pull requests, **not deployed**.

## Server configuration (Render)
- `SKYBOX_API_KEY`: provider-issued API key; keep only in server secrets. Never expose via frontend or logs.
- `SKYBOX_GENERATION_ENABLED=false`: default safe mode; no paid generations. Change to `true` only after confirming the provider API plan, endpoint compatibility, spending budget, and explicit operational approval.

## Endpoints (authenticated ADMIN / DIRECTOR only)
- `GET /api/projects/3/360-ai/skybox/status`: reports configured/enabled flags, never key.
- `GET /api/projects/3/360-ai/skybox/styles`: read-only provider style lookup.
- `GET /api/projects/3/360-ai/skybox/jobs/:jobId`: read-only job status lookup.
- `POST /api/projects/3/360-ai/skybox/generate`: requires an inactive tour belonging to project 3, a room, a valid style ID, `approved: true`, and server-side feature flag. Each call can consume credits.

## Important limits
A successful generation creates a **Skybox job**, not a registered panorama. There is **no automatic download/import, floorplan verification, room linking, activation or publication**. Downloading completed jobs into the private bucket must be separately implemented and tested with strict network/redirect limits and image checks. Existing import helper is not exposed as an HTTP endpoint.

Skybox API calls have not been exercised against a paid provider account. Confirm API version, style IDs, job schema and commercial usage rights before enabling the flag. Do not merge or deploy without a release gate.
