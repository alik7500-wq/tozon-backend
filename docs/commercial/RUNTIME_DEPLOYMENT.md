# Isolated test application deployment — prepared, not published

Date: 2026-10-29.

## Reviewed sources

| Component | Repository | Branch | Status |
| --- | --- | --- | --- |
| API | https://github.com/alik7500-wq/tozon-backend | commercial/isolated-installation | Local changes prepared |
| UI | https://github.com/alik7500-wq/tozon-crm | commercial/isolated-test-runtime | Local commit 6a2e4be |

Both existing repositories are public. Publishing these commits would expose the new implementation and schema definitions publicly. No customer rows or production credentials are included in the prepared changes. The tracked `.env` files are removed from the new branch tips; older repository history is not changed.

Frontend push was rejected by automatic approval review: deployment preparation was not considered sufficient authorization to disclose code to that specific GitHub destination. No alternate publishing channel was used. Explicit user approval is required before retrying that publication. No new Render services have been created.

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

The setup/ready HTTP behavior is tested locally. No deployed HTTP/browser flow or real service-role API connection has been verified yet.

## Publication and configuration after user approval

1. Push the two reviewed branches, never main. Use independent services and disable automatic deployments unless deliberately required.
2. Create a separate Render Node web service on `free` and a separate static site. Check current plan availability/quotas. No paid service/cron/database is required by this proposal.
3. Configure explicit test URLs/public key; use new secrets only. Generate the separate JWT secret through a supported secure mechanism.
4. Add the test project's server key directly in the new API service's Render Environment panel. Do not request or paste it into chat and do not reuse production environment groups.
5. Monitor deploy IDs to live. Verify `/api/health` accurately reports setup/ready and cross-origin denial.
6. Provision a separate test administrator and synthetic company data; then verify login, inventory/deals/finance and relevant reports through HTTP/UI.

The rendered setup page alone must never be described as a fully functioning CRM.
