# Isolated test application deployment — live setup mode

Date: 2026-10-29.

## Reviewed sources

| Component | Repository | Branch | Status |
| --- | --- | --- | --- |
| API | https://github.com/alik7500-wq/tozon-backend | commercial/isolated-installation | Published; deployed commit 51876ceb17235ed1be2054e1faa8437c23194a86 |
| UI | https://github.com/alik7500-wq/tozon-crm | commercial/isolated-test-runtime | Published; deployed commit 9037de86e96edce2977cc50c5efe1be5c4ebf8a1 |

Both existing repositories are public. Publishing these commits would expose the new implementation and schema definitions publicly. No customer rows or production credentials are included in the prepared changes. The tracked `.env` files are removed from the new branch tips; older repository history is not changed.

The user explicitly approved publication to both public repositories and separate test deployment. Shell Git push lacked credentials; the authenticated GitHub connector published the changes. Returned Git tree hashes exactly matched the locally reviewed trees. No main branch or production service was updated.

## Deployed resources

| Component | Render service | Public URL | Deploy |
| --- | --- | --- | --- |
| API | srv-dbhgs3e1egvs73fhojgg | https://tozon-crm-commercial-test-api.onrender.com | dep-dbhgs4e1egvs73fhokrg |
| UI | srv-dbhgs7fb9u1s73er8rl0 | https://tozon-crm-commercial-test.onrender.com/ | dep-dbhgs7nb9u1s73er8sdg |

Both deploys reached `live`. API uses Free compute in Frankfurt; the UI is a static site. Automatic deploy is disabled on both services. A separate random JWT secret was generated and stored only in the new API service's environment; it was not written to source or this report.

Live checks:

- UI HTTP 200; rendered browser page displays the test environment and setup message.
- API `/api/health`: HTTP 200, `status: setup_required`, `crmReady: false`, missing only `SUPABASE_SERVICE_ROLE_KEY`.
- Requests from the dedicated UI origin receive its exact CORS allow-origin; production UI origin is denied with HTTP 403.
- Business login route returns HTTP 503 without connecting to production or exposing application routes.
- Runtime logs confirm `npm run commercial:start` and the isolated server listening; no legacy production startup was invoked.

**The web services are live, but database-backed CRM operation and login are not ready.** The server key cannot be retrieved using the available Supabase connector, and the connected local browser is unavailable. The user must add the isolated project's Secret key (`sb_secret_...`) directly in the new API service Environment panel as `SUPABASE_SERVICE_ROLE_KEY` and choose Save and deploy. Do not paste it into chat or use a production key. API dashboard: https://dashboard.render.com/web/srv-dbhgs3e1egvs73fhojgg .

## Runtime contract

API entry: `npm run commercial:start`, separate from production `npm start`.

- Requires `COMMERCIAL_RUNTIME_CONFIRM=ISOLATED_TEST_RUNTIME`.
- Only accepts `SUPABASE_URL=https://yaolkwbnhnacxxjpgiyu.supabase.co`.
- `FRONTEND_ORIGIN` must be the dedicated Render test site's exact HTTPS origin.
- Requires a new test-project `SUPABASE_SERVICE_ROLE_KEY` or `sb_secret_` server key, and a separate random `JWT_SECRET` (48+ characters).
- Legacy JWT service keys are checked for project ref and service role; public keys and production-project JWTs are rejected. Modern server keys are checked against the isolated project's API before mounting the application.
- The legacy dotenv loader is redirected to `/dev/null` before importing application/database modules. The tracked production `.env` is excluded from the branch tip.
- No production startup, Telegram bot, cron scheduler or one-time Tour30 production task is invoked.
- SMS, calls, automation, finance bot and inbound lead webhooks are blocked in this test entry. External integration credentials are rejected.
- Without server credentials the service serves only setup status (`crmReady: false`) and returns HTTP 503 for business endpoints. No administrator/login is created yet.

The main application is mounted only after a server-role query to the isolated `users` table succeeds. This is technical readiness, not full product acceptance. Module-specific authorization and complete UI/financial workflows remain release checks.

## Frontend contract

- Requires explicit `VITE_COMMERCIAL_TEST=true`, the isolated API URL, the test Supabase URL and its **public/publishable** key.
- No production API/database fallback remains. Vite env-file loading is disabled for this branch to prevent loading the old developer `.env`.
- Build configuration validates endpoint/key selection before building; secret Supabase keys are rejected from frontend configuration.
- Production webhook URLs, Cloudinary fallback, finance bot link and pilot Skybox links are removed or disabled in the commercial test.
- Startup gate displays setup status until the isolated API reports technical readiness. No fallback to the working CRM occurs on connection failure.

## Validation completed

- Backend: 41 targeted tests passed (schema, guard, runner and isolated runtime).
- Frontend: 2 endpoint/public-key validation tests passed.
- Production frontend build completed.
- Built JS assets contain no production TOZON API/database URLs or POPUTKI database URL.
- Git whitespace checks pass.

Setup mode has been verified through deployed HTTP requests and the rendered UI. A real service-role API connection, administrator login and full application flows remain unverified until the user configures the test key.

## Remaining configuration and acceptance

1. User adds only the new test project's Secret key in the API service Environment panel as `SUPABASE_SERVICE_ROLE_KEY`, then saves and deploys. The separate JWT secret and all non-secret URLs are already configured.
2. Monitor the new deploy to live and verify `/api/health` reports ready, with the expected isolated project ref.
3. Provision a separate test administrator and synthetic company data; verify login, inventory/deals/finance and relevant reports through HTTP/UI.
4. Configure Storage/templates and additional onboarding fields as needed. Keep external integrations disabled until independently configured for this environment.

The rendered setup page alone must never be described as a fully functioning CRM.
