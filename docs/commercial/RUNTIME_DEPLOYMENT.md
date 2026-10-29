# Isolated test application deployment — connected demo environment

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
| API | srv-dbhgs3e1egvs73fhojgg | https://tozon-crm-commercial-test-api.onrender.com | dep-dbhhr761egvs73fk0atg |
| UI | srv-dbhgs7fb9u1s73er8rl0 | https://tozon-crm-commercial-test.onrender.com/ | dep-dbhgs7nb9u1s73er8sdg |

Both deploys reached `live`. API uses Free compute in Frankfurt; the UI is a static site. Automatic deploy is disabled on both services. A separate random JWT secret was generated and stored only in the new API service's environment; it was not written to source or this report.

Live checks after the user configured the isolated server key:

- New API deploy `dep-dbhhr761egvs73fk0atg` reached live on commit `22980ec0a2cf3dfb7e0166f4352fd1eb0894ed14`.
- API `/api/health`: HTTP 200, `status: ready`, `crmReady: true`, expected isolated project ref, no missing variables.
- Browser UI transitions from setup to the login form at https://tozon-crm-commercial-test.onrender.com/login . Browser sign-in itself has not been automated; credential submission was verified through the application's HTTP API.
- Test administrator login returned HTTP 200 without a password hash in the response. Authenticated checks of identity, projects, inventory structure/statistics, dashboard, finance access/income/expenses/cashflow, construction, summary reports, users and dictionaries all returned HTTP 200 (13 checks).
- A separate synthetic administrator `admin@tozon-test.example` (id 3), generic demo company, project (id 3), two apartments and an empty cash desk were provisioned only in the isolated database. Initial payments and expenses are zero. No production account, password, customer or financial records were copied.
- The generated administrator password is not stored in source/reports; it is supplied only for the user's test login. The Supabase server key was entered by the user directly in Render and was never retrieved by the agent.
- SMS, calls, automation, Telegram and inbound lead webhook integrations remain blocked by the isolated entry point.

This verifies initial demo access and representative API reads. Full browser/user workflows, document/media storage, every financial mutation and all roles still require acceptance tests.

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

Setup mode has been verified through deployed HTTP requests and the rendered UI. The real service-role API connection and administrator HTTP login have now been verified. Full browser workflows and all modules remain acceptance tasks.

## Remaining acceptance work

1. User signs into the test site using the separate test administrator and changes its password in the user settings if desired.
2. Verify through the interface: object/apartments, a fictitious buyer, contract, payment, expense, construction and relevant reports. Existing HTTP checks cover representative reads, not every workflow.
3. Configure independent Storage/templates and complete onboarding fields. Keep integrations disabled until independently configured for this environment.
4. Review all roles and financial scenarios before any commercial-client rollout. No main-branch merge or production deployment is part of this environment.
