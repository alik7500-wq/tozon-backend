# Commercial installation — isolated database (draft)

This branch is for developing installations for independent construction companies. Never run installation or migration commands against the existing TOZON production database.

## Isolation contract
- Each customer has their own Supabase project (PostgreSQL database, Storage, authentication-related configuration and keys).
- Each customer has dedicated backend/frontend deployments, secrets, webhook endpoints and domain settings.
- No production TOZON customer records, payments, contracts, SMS history, uploaded documents or service keys may be copied to a new installation.
- Application source can be shared; runtime data and credentials cannot.

## Known blocker
`src/db/migrate.js` currently calls SQLite-style `exec`, `prepare` and `transaction` on a Supabase JS client. It must not be used for provisioning PostgreSQL. A PostgreSQL-compatible, transactional and repeatable migration runner must be built and tested on a disposable test database before replacing it.

## Progress — 2026-10-28
The dedicated Pro test project is active. Four commercial migrations now cover all 73 captured production tables, a generic company-settings table, a private zero-based document counter, 45 backend-only invoker functions, 16 triggers and one invoker view. The cloud repeat install and synthetic financial/assignment scenario passed; 38 local tests passed. No application rows or production credentials were copied. Full CRM readiness remains false until isolated application deployment, onboarding and end-to-end authorization/functional checks pass. See [TEST_ENVIRONMENT.md](TEST_ENVIRONMENT.md) and [CLOUD_SCHEMA_VERIFICATION.json](CLOUD_SCHEMA_VERIFICATION.json).

## Required release gates
1. Inventory all schema definitions and migration dependencies.
2. Build a PostgreSQL-only installer with explicit target checks and an isolated migration ledger.
3. Test clean install, repeat run, failed migration rollback and startup on a disposable Supabase project.
4. Externalize company branding, privileged administrator configuration, URLs, allowed origins and integrations.
5. Verify strict separation of customer data, documents and credentials.
6. Obtain explicit approval before any merge into `main` or production deployment.
