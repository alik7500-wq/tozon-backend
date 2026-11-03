# AVJ CRM — Instagram Unified Login integration (implementation contract)

Status: design / not deployed. Meta app created; no Instagram account connected yet.

## Verified codebase
- Frontend: `alik7500-wq/tozon-crm` (React 19 / Vite).
- Backend: `alik7500-wq/tozon-backend` (Express 5), entry `src/app.js`.
- Existing lead intake and automation routes must remain unchanged.

## Meta setup
- App display name: AVJ CRM.
- Instagram use case: Instagram API (Unified Login).
- Registered redirect URL **only after the route exists and is tested**:
  `https://tozon-backend.onrender.com/api/integrations/instagram/callback`
- Do not paste app secrets, access tokens, or webhook verify tokens into GitHub, chats, or frontend code.
- In development mode, assign the Instagram professional account as an app tester/authorized role before testing.
- Obtain necessary permissions and app review for other developers' accounts.

## Security and tenancy requirements
1. Authenticated CRM administrator starts the flow for a server-validated tenant ID. Never accept tenant ID from an unauthenticated query.
2. Create a short-lived one-time random OAuth state tied to the initiating user, tenant, requested provider, expiry and browser session. Store its digest server-side; consume atomically.
3. Redirect only to the exact Meta-approved callback URI. Validate state, issuer/provider, expiry and error parameters before exchanging the code server-to-server.
4. Exchange authorization code only on backend using Meta app credentials from environment variables. Do not expose tokens to frontend or log them.
5. Encrypt access tokens at rest with a separate encryption key; store expiry, granted scopes, provider account ID, tenant ID and status. Never use a shared token across tenants.
6. Verify Instagram account identity and permissions before marking connection active. Enforce uniqueness and authorized ownership of account connections.
7. Provide disconnect/reconnect and token expiry handling, with audit trail and safe retries.
8. For webhook endpoint, verify Meta challenge on GET and request signatures on POST using raw request body, then deduplicate events and route by connected provider account to correct tenant. Never reuse the existing lead intake webhook.
9. Avoid global `cors({ origin: true, credentials: true })` for OAuth operations; use secure, scoped state/session binding and strict allowed origins.
10. Cover negative tests: missing/forged/replayed/expired state, wrong tenant, invalid signature, missing env, denied consent, duplicate event, token exchange failure.

## Integration boundaries
- Backend callback: `GET /api/integrations/instagram/callback`.
- Backend connect: `POST /api/integrations/instagram/connect` (authenticated tenant admin).
- Backend status/disconnect: `GET/DELETE /api/integrations/instagram/connection`.
- Separate webhook: `GET/POST /api/integrations/instagram/webhook`.
- Frontend Automation page: Connect / Connected / Reconnect / Disconnect; show actual authorized Instagram handle and tenant, not an assumed `@tozon_plaza`.

## Deployment gate
Do not deploy to production until OAuth, database isolation, signature validation, credential setup, integration tests and rollback procedure are complete. Meta redirect registration alone does not implement OAuth.
