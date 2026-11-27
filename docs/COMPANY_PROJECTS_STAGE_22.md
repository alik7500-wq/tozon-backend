# Stage 22 — Isolated project cash book

## Delivery

Backend runtime: `d1ec5ba417ca9d5ac98cf3406532f704ae97e5f9`.
Frontend runtime: `5f61c13754cd154a3eabc0520df276b83b1c1f19`.
Branch: `feature/company-projects-foundation` in both repositories.
Test API deploy `dep-dbtdfmjm8hqs73ajjn30` and test static deploy `dep-dbtdfn3ncjis739ul870` both reached `live` on the runtime commits above. Both test services retain automatic deployment off. Test API health reports `isolated-project-pilot` and `external_sends=false`.
Test-only migration: `20261116101424_company_project_cash_book.sql`, applied to `yaolkwbnhnacxxjpgiyu`. Created using the CLI; filename aligned with the hosted migration-history version.

## Behavior

The scoped workspace has Finance → Cash book. Users choose an assigned cash desk and inspect income/expense documents, recorded currencies, settlement type, operation type and status. Journal filters cover currency, direction and dates, with 100 visible rows per page. Account totals remain explicitly for the entire desk history, independently of journal filters; currency equivalents are not added twice. Exact Postgres decimal strings are formatted without browser floating-point arithmetic. Inactive assigned desks remain available for historical review. An empty desk does not acquire an invented opening balance.

The legacy finance implementation revealed an important limitation: an internal cash transfer can have a TJS master record but USD-normalized payment/expense legs. Legacy barter reclassification and ambiguous settlement data also prevent a reliable cash balance based on a naïve sum. This stage deliberately withholds the entire balance when any active selected-desk record is a transfer, conversion, bank/barter/unknown settlement, unknown operation, invalid amount/currency or unknown status, or the desk has an active barter reclassification. Documents remain inspectable with a visible reconciliation notice. This is not a replacement FX, transfer or barter accounting engine.

For an unambiguous cash-only history, totals use all ACTIVE/POSTED rows without voided_at, grouped by their recorded currency. VOIDED/CANCELLED/REVERSED rows and any voided_at record remain in the journal and are excluded from totals. No current exchange rate is used. Completeness of opening balances and history remains a business prerequisite, stated in the UI.

## Isolation and boundaries

GET `/api/project-workspace/:project/cash-book` accepts only optional UUID `cash_desk_id`. Actor identity comes from verified authentication; actor/query overrides and repeated/unsupported parameters are rejected. The existing isolated-runtime guard and no-store policy apply.

The server-only SECURITY INVOKER function with empty search_path requires BOTH current finance.payments and finance.expenses project grants and current enabled membership/roster. The selected cash desk must belong exclusively to the project. Every historical linked deal must have the project's unit hierarchy and lead mapping; a non-null explicit deal project must agree. Contradictions stop the entire book with a generic 409, rather than silently excluding financial rows. Archived inventory is valid for financial history. Customer names, private fields, foreign desk names, descriptions, contract details and transfer counterpart IDs are not returned. More than 5000 documents stops with a bounded-report error, without a truncated balance.

Execute is revoked from PUBLIC/anon/authenticated and granted only to service_role. No employees, grants, project mappings, accounting documents, posting algorithms or production deployment settings are changed.

## Validation

- Isolated backend suite (`src/modules/company-projects`, `src/pilot`, selected pricing path): 249 tests / 29 files passed. New cash book SQL tests: 10; strict authenticated route coverage added. The 10 SQL tests passed again after the final status rendering and migration filename alignment.
- Frontend selected workspace/pricing/update suite: 79 tests / 16 files passed. Build-version/update checks: 7 tests / 2 files passed (includes a repeated update test file). Cash-book UI tests cover filtering without changing all-time totals, reconciliation warning, desk switching, permission revocation, pagination, voided records and missing desks.
- Flagged production build and changed-file oxlint passed. Existing large-bundle warning remains. Both repositories passed git diff --check and staged-tree equality against the fetched published runtime commits.
- An attempted repository-wide npm test was not completed: automatic approval review blocked it because legacy tests can connect to production Supabase. It was not retried or bypassed. The isolated suites above use local PGlite fixtures or mocked dependencies; no blanket full-suite success is claimed. Repository-wide lint also did not pass; changed-file lint passed.
- Hosted test RPC: actor 4 can list only the two assigned Plaza desks. The demonstration desk is empty. The existing manager desk payment #51 is 680.00 USD; income 680.00, expense 0.00, balance 680.00. This existing payment was not created or altered in this stage. Payments remain 1, expenses remain 0.
- Function privilege check: anon=false, authenticated=false, service_role=true, security_definer=false. Security advisor remains 93 INFO rls_enabled_no_policy findings and no WARN/ERROR; server-only tables have no new browser grants. Reference: https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy.
- Live browser verification under existing test employee Plaza: only the two assigned cash desks are listed; demonstration desk has a truthful empty journal; manager desk displays existing PKO #51 dated 12.11.2026 and all-time income/balance 680.00 USD. Expense filter produces zero matching documents while the full-history balance stays 680.00 USD. Resetting the filter and Refresh restore the document. [Browser screenshot](qa/company-project-cash-book.png).
- The tab initially entered through the ordinary test root and received the new-version notification while still on the previous release. Clicking its normal Update application link loaded the new Finance → Cash book menu with the same signed-in employee, verifying that release-notification/update flow live. No unsaved draft was present, so draft preservation during this specific live update was not retested.

## Remaining work

Physical reconciliation for legacy mixed-currency transfers, conversions, barter/bank settlement, period opening/closing statements, cash corrections, refunds and production rollout remain separate. No production_ready flag is set and the full legacy CRM migration is not declared complete.
