# Stage 25 — Permission-scoped project search

## Delivery

- Backend runtime: `03fa9e68c22800d24b2ab42516d961681ad97dee`.
- Frontend final runtime: `531e2efb80c5a7eb90dd486ff82a57ac7224c349`.
- Branch: `feature/company-projects-foundation` in both repositories. Only the isolated test API/static services are deployed; automatic deployment remains off. No production/main release.
- Test-only migration `20261116181948_company_project_search.sql`, applied to `yaolkwbnhnacxxjpgiyu`. Created using the Supabase CLI, then filename aligned with actual hosted migration history.
- Test API deploy `dep-dbtkj7942hec738uem20` and final test static deploy `dep-dbtkkk1srm7s73egntdg` both reached `live` on the runtime commits above. Health reports `isolated-project-pilot`, `external_sends=false`.

## Behavior

The workspace has a search panel above its current section. It searches the complete authorized project data, independently of visible list pages: contact name/phone, contract number/date and unit number/complex. Phone matching supports both the recorded text and normalized digits, including numbers entered with spaces, brackets or hyphens. Matching is case-insensitive, including Cyrillic; wildcard characters are literal. Input is 2–100 characters, with a single digit allowed for one-digit unit/contract numbers.

Results are grouped by granted section. Each group returns at most 10 matches and explicitly asks to refine the query if more exist; no global total is exposed. Clicking a result performs a new authenticated, scope-checked record lookup before displaying its minimal preview. A permitted contract preview can open the existing scoped Documents dialog; this stage does not add document writes or external sends.

Editing or clearing the query removes the previous matches and aborts the old request. Changing project, actor or granted sections resets the panel. Periodic authorization refresh reloads both search and selected record. A search failure hides old matches. If the selected record returns 401/403/404, all cached matches and preview details are hidden immediately; transient record errors show an error without a stale preview.

## Server boundary

GET `/api/project-workspace/:project/search?q=...` and GET `/api/project-workspace/:project/search/:resource/:record` accept strict parameters and take actor identity only from verified CRM authentication. Actor overrides, duplicate/unknown query fields, unsupported record types and out-of-range IDs are rejected. Existing test-runtime, project-only account, trusted cookie origin and no-store guards apply.

The server-only SECURITY INVOKER RPC `search_company_project_workspace` has empty search_path, fixed resource SQL, bound parameters, current roster/membership/section checks and explicit minimal projections. It never searches an ungranted resource or uses hidden contact fields to match a contract. Client names/phones appear only under leads.view; contract results contain number/date/status; unit results contain number/complex/status. No passport, partner, financial amount, foreign project, transfer counterpart or file fields are returned.

Units require the complete own, unarchived hierarchy. Contracts require an own unit hierarchy, own lead mapping and agreement of any non-null explicit company_project_id. Foreign/moved/archived record IDs return generic 404. PUBLIC/anon/authenticated execution is revoked; only service_role may execute. No table grants, employee access, company mappings or business records are modified.

## Validation

- Isolated backend suites: **259 tests / 30 files passed**. Focused final search/router suite: **25 tests passed**; the 9 SQL tests passed again after migration filename alignment.
- Frontend workspace/pricing/update/build-version suites: **100 tests / 19 files passed**. Final affected search/page tests after the cached-result denial guard: **19 tests passed**. Changed-file lint and flagged production build passed; existing large-bundle warning remains.
- Tests cover two-project isolation, unrestricted-admin refusal, fresh grants/roster/active-user revocation, no matches from ungranted sections, explicit conflicting contract projects, archived/moved records, literal wildcards/injection strings, formatted phone/Cyrillic matching, numeric query, records beyond list page 1, per-section cap, strict routes, direct browser-role denial and absence of business writes.
- UI tests cover fresh record previews, old-query abort/late responses, hiding matches/details after access denial, query clearing on project/grant changes, no search for finance-only users, honest empty/capped results and permitted contract-document opening.
- Hosted test RPC under existing employee 4: query 101 returns only own unit 3, title 101, Demonstration complex, SOLD; fresh unit preview agrees. Execute privilege checks: anon=false, authenticated=false, service_role=true, security_definer=false.
- Security advisor unchanged: 93 INFO rls_enabled_no_policy findings, no WARN/ERROR. Server-only table access is not widened. Reference: https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy.

## Live browser verification

Existing scoped employee Plaza entered through the normal test root and used the normal update link. Search is above the current section. Query 101 returned only the assigned demonstration unit; opening it displayed Demonstration complex and Sold status after a fresh record request. Query 0001 returned the own signed contract dated 29.10.2026; opening the result exposed its permitted Documents action, which successfully opened the existing scoped Documents dialog for contract 0001 and unit 101. No print, Word download, upload or mutation was invoked. [Browser screenshot](qa/company-project-search.png).

A transient Network Error occurred during a context refresh. The workspace and search data were hidden; the next successful authorized refresh restored the project with cleared search. Test API health was successful during the recovery. This verifies conservative handling of the observed failure, not a guarantee of uninterrupted hosting/network availability. Multi-project denials, revoked permissions and removed records were verified using isolated fixtures rather than changing live staff grants.

## Remaining scope

This delivers search and minimal read-only previews, not unrestricted legacy search, editing forms or production activation. Financial/integration/file search is intentionally outside this endpoint. Full production data classification, real project/staff assignments, owner confirmations, legacy reconciliation, external integrations and controlled production migration remain separate steps.
