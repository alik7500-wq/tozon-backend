# Commercial installation — isolated database (draft)

This branch is for developing installations for independent construction companies. Never run installation or migration commands against the existing TOZON production database.

## Isolation contract
- Each customer has their own Supabase project (PostgreSQL database, Storage, authentication-related configuration and keys).
- Each customer has dedicated backend/frontend deployments, secrets, webhook endpoints and domain settings.
- No production TOZON customer records, payments, contracts, SMS history, uploaded documents or service keys may be copied to a new installation.
- Application source can be shared; runtime data and credentials cannot.

## Known blocker
`src/db/migrate.js` currently calls SQLite-style `exec`, `prepare` and `transaction` on a Supabase JS client. It must not be used for provisioning PostgreSQL. A PostgreSQL-compatible, transactional and repeatable migration runner must be built and tested on a disposable test database before replacing it.

## Required release gates
1. Inventory all schema definitions and migration dependencies.
2. Build a PostgreSQL-only installer with explicit target checks and an isolated migration ledger.
3. Test clean install, repeat run, failed migration rollback and startup on a disposable Supabase project.
4. Externalize company branding, privileged administrator configuration, URLs, allowed origins and integrations.
5. Verify strict separation of customer data, documents and credentials.
6. Obtain explicit approval before any merge into `main` or production deployment.
