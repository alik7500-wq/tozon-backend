# Commercial CRM test environment — schema reconciliation

Updated: 2026-10-28. Branch: `commercial/isolated-installation`.

## Current result

Organization `chifir` (`wvourzoicdvmeioqbipu`) is Pro. Dedicated project `tozon-crm-commercial-test` (`yaolkwbnhnacxxjpgiyu`) is in `eu-central-1`.

The schema was installed, repeated and verified in that test project:

- All 73 captured production public tables are represented, with all captured columns, types and nullability.
- One additional generic `company_settings` table: **74 public tables** total.
- One private technical table `tozon_internal.customer_pko_counter`.
- 45 functions and 16 triggers, plus the `construction_expense_settlements` view with `security_invoker=true`.
- Four immutable commercial migration ledger entries, with SHA-256 checksums.
- All 75 application/technical tables have RLS. No table or function execution grants for `anon` or `authenticated`. All copied functions use SECURITY INVOKER and a fixed search path; trusted `service_role` is the only application execution role. Backend authorization is still required.

**This is a database schema preview, not a deployed or release-ready CRM.** No frontend/backend deployment or administrator login has been created. `crmReady` remains false. Full behavioral validation of every module/function is pending.

## Production access and data isolation

The only production operations in this stage were read-only queries against PostgreSQL catalogs for column, constraint, index, view, function and trigger definitions. No application table rows, customer details, financial records, document contents, passwords or service keys were retrieved. Production was not modified.

Catalog definitions were captured in the schema-metadata JSON files and `function-definitions-metadata.json`. These are schema definitions, not a data backup. The packaged commercial schema is built offline by `scripts/commercial/build-extended-schema.py`; it never connects to a database and imports none of the historical repair migrations.

Reviewed commercial differences:

- Serial IDs become local identity sequences. Production sequence values are never copied.
- Customer PKO counter starts at **0**, and its check becomes `last_number >= 0`; the historical production lower bound of 94 is excluded.
- SMS sender `TOZON-PLAZA` and construction start date `2026-10-01` defaults are removed. Client configuration must supply them.
- Production grants, RLS policies and SECURITY DEFINER privileges are not copied. The preview is backend-only and denies browser database access.
- Six generic system-role definitions, an empty document-settings record, and the zero technical counter are initialized. No actual users, companies, buyers, cash desks, contracts, balances, notifications or integrations are seeded.
- Compatible legacy text timestamps/integer minor units are retained. This migration does not redesign the accounting rules or fix all inherited business-logic risks.

## Verification

Run:

```sh
npx vitest run src/db/commercial-install-guard.test.js src/db/commercial-migration-runner.test.js src/db/commercial-core-schema.test.js src/db/commercial-extended-schema.test.js --fileParallelism=false
```

**38 tests passed** on PGlite. Coverage includes production-target rejection, bootstrap/core/schema upgrades, transaction rollback, history checks, repeat execution, column/type/nullability parity, API role denial, invoker permissions and fixed function search paths.

`commercial-schema-smoke.js` provides the shared synthetic scenario. It was executed locally and in the isolated cloud database as `service_role`: project hierarchy, lead assignment, signed deal, duplicate active sale rejection, income payment, PKO numbering from 1, schedule recalculation, expense idempotency, insufficient-funds rejection, payment voiding and PKO number retention. No SMS events were queued without configuration. The transaction was rolled back; users, payments, expenses and the technical counter remain empty/zero. Identity sequences can advance on rolled-back inserts.

Cloud repeat execution retained exactly four ledger entries. Evidence: `CLOUD_SCHEMA_VERIFICATION.json`.

Advisor results:

- Security: 75 informational [RLS enabled without policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) findings. Intentional backend-only deny-by-default setup; do not create broad allow policies to silence them.
- Performance: 58 informational [unindexed foreign keys](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys), 120 unused-index notices on an empty database, and default Auth connection-allocation notice. Index tuning remains a release task.
- No warning/error-level findings were returned by these advisor calls. This is not a complete security or financial audit.

## Installer operation

Use the private test environment based on `commercial-test.env.example`. Never load the production `.env`. Passwords must be URL-encoded; the direct driver requires verified TLS. No secrets belong in git or shell history.

- `npm run commercial:install -- --plan-schema`: offline manifest/checksum review; no connection.
- `npm run commercial:install -- --apply-schema`: direct-driver transaction with isolated credentials.
- `npm run commercial:install -- --export-schema-sql`: export a single atomic DO statement for SQL Editor/MCP migration transport; no connection or credential output. Independently verify the selected project matches the embedded ref before running it.

The SQL transport and direct runner share manifest/checksums, target-ledger binding, advisory lock, first-install empty-public check, history validation and transaction rollback. The SQL transport does **not** cryptographically prove the actual server identity; the operator must select the correct project. Never execute generated SQL in either production project.

Bootstrap/core-only commands retain their old manifests. Once extended migrations are installed, use schema commands: older manifests correctly reject unknown applied history. Do not regenerate/change any applied migration or snapshot used to build it; add a new reviewed migration instead.

Never use legacy `npm run migrate` for provisioning PostgreSQL.

## Remaining work before a working test CRM

1. Configure a dedicated backend/frontend deployment, test-only server credentials, JWT secret and allowed origins. Do not reuse production keys, webhook secrets or notification credentials. Direct-driver TLS and simultaneous remote installers have not been exercised.
2. Implement onboarding for the company, administrator, cash desks, construction start date, document numbering/templates, media Storage and optional integrations. No real company templates/documents were copied as records.
3. Check the application through HTTP/browser: login, permissions, inventory, customer/deal lifecycle, construction, finance, reports and error recovery. Database smoke tests are not end-to-end UI tests or proof that every financial scenario is correct.
4. Verify API boundary authorization and deny paths using the actual backend. Caller-supplied actor IDs in copied RPCs are trusted only because these functions are restricted to the backend role.
5. `SCHEMA_DEPENDENCIES.json` has no missing literal RPC names. The one missing table candidate, `tour360_publish_jobs`, belongs to an explicitly unreleased journal repository (no HTTP endpoint); its proposal migration was intentionally not deployed. Dynamic table names and Storage require manual review.
6. Review foreign-key indexes and remaining branding/configuration in application code. Database schema generalization alone does not make the whole product universal.

No main-branch merge or production deployment was performed.
