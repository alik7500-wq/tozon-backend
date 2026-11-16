# Stage 21 — Project warehouse stock balances

## Delivery

- Backend runtime e8256f96a25a6f85d66def27150b6800d70f4eba; test API deploy dep-dbtcuauc6qcc738rffjg live.
- Frontend runtime 5f22b7a7c8689a00dfb21138730b71504c1beda9; test static deploy dep-dbtcub3bc2fs73dq5qcg live.
- Both repositories remain on feature/company-projects-foundation; both test services retain auto-deploy off. No production/main deployment.
- Test-only migration 20261116093608_company_project_stock_balances.sql applied to yaolkwbnhnacxxjpgiyu. The migration was created with the CLI and its filename aligned to the actual hosted migration-history version after application.

## Behavior and scope

Warehouses in the scoped workspace now show current stock quantities, material units and accounting value, with totals separated by currency, warehouse selection, local material/currency filters and refresh. The source is the existing signed construction_stock_entries ledger; no replacement costing, market price, FX conversion or new posting engine is introduced. Materials with historical balances and inactive assigned warehouses remain available. Fully zero balances are omitted; quantities with different units are not added together. Postgres numeric values travel as decimal strings and are formatted without floating-point conversion in the browser.

GET /api/project-workspace/:project/stock accepts only an optional UUID warehouse_id. The authenticated actor is taken from the verified CRM identity. Existing exact test-runtime guards and project-only boundary apply. The server-only SECURITY INVOKER RPC, with empty search_path, checks current membership and construction.stock access through the existing context reader, then validates the selected warehouse's exclusive project assignment. Foreign IDs produce no foreign names or rows.

Before aggregation, every selected-warehouse ledger entry must reference a posted document, matching currency, an own source warehouse, an own destination for transfers and an own physical complex when specified. Conflicting links stop the entire report with a generic 409; a partial balance is never silently returned. More than 5000 nonzero material/currency groups produces a bounded-report error instead of silent truncation. No customer, supplier, employee or contract fields are returned.

No employee permissions, warehouse mappings, business documents or financial rows changed. The only new database object is a read RPC; execute is revoked from PUBLIC/anon/authenticated and granted to service_role.

## Validation

- Backend: 265 tests / 31 files passed, including 10 new SQL tests and strict stock route coverage. After the migration filename alignment, all 10 stock SQL tests passed again.
- Frontend: 92 tests / 20 files passed. The final formatting-helper extraction passed its four affected UI tests. Build and changed-file oxlint passed; existing large-chunk warning remains. Both repositories passed git diff --check and staged-tree equality against fetched published commits.
- SQL tests cover own-project isolation, foreign project/warehouse refusal, unrestricted-admin refusal, revoked permissions, historical inactive warehouses/materials, signed ledger summation, separate currencies, exact large decimals, own transfers, conflicting warehouse/complex/status/currency links, report-size refusal and browser-role execution denial.
- Live test DB: actor 4 read only the assigned Test Plaza warehouse with empty records/totals. anon/authenticated execute=false, service_role execute=true, security_definer=false. Stock entries and construction documents remained zero before and after the change.
- Security advisor findings unchanged: 93 INFO rls_enabled_no_policy notices, no WARN/ERROR. Tables deliberately remain server-only; no browser grants were added. Reference: https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy.
- Real Chrome at the ordinary root URL, existing Plaza test employee: Warehouses opened with only Test Plaza warehouse, material search, currency filter, truthful empty-stock message and working Refresh action. [Browser proof](qa/company-project-stock.png).

## Limits and remaining work

No production inventory was copied. The test warehouse has no opening balance or movements, so populated reports and cross-project denials were verified using isolated automated fixtures, not invented persistent business records. Opening balances must be entered through the existing authorized stock-document workflow using actual quantities and values.

This stage delivers stock balance reading. Cash balance/DDS reports, financial or stock corrections, customer refunds and broader production migration remain separate work. This does not declare production_ready=true or complete the full legacy CRM port.
