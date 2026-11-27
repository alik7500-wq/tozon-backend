# Stage 35 — preserved warehouse and construction history

Only isolated test `yaolkwbnhnacxxjpgiyu` was modified. The source remains the consistent Stage 31 snapshot of `yeslzrrcwgcqfxhgbrqk`, captured at 2026-11-26 18:52:38 UTC. Production and employee permissions were not changed.

Batch `0ee556f1-3cb3-4e1b-9b6d-940bd8defc3f` committed at **2026-11-27 06:24:48 UTC** (11:24:48 Asia/Karachi).

| Imported source table | Rows |
|---|---:|
| construction_warehouses | 1 |
| construction_materials | 16 |
| construction_documents | 16 |
| construction_stock_entries | 30 |
| construction_settlement_entries | 9 |
| construction_price_corrections | 8 |
| construction_expense_settlement_audit | 10 |
| construction_report_receipts | 0 |
| **Total public history rows** | **90** |

The documents retain their original numbers, dates, authors, posted status and posted timestamps: 11 receipts and 5 write-offs. Original ledger entries were copied directly; no application posting/approval/payment action was invoked. Quantities, values, prices, currencies and rates were carried as PostgreSQL JSONB/numeric data, without parsing real monetary payloads into JavaScript numbers.

## References and evidence

Declared FK references use the prior identity map. Material IDs inside live document `lines` are also remapped, retaining line order, quantity, value and all other fields. The top-level expense link in the expense-settlement audit, which lacks a source FK, is resolved explicitly. Before/after audit JSON and price-correction JSON retain original source identities as immutable evidence; a future history viewer must resolve those source identities through the import ledger.

Six audit rows describe three expenses already deleted in the source snapshot. Each missing expense has explicit DELETE evidence. These rows retain their original expense ID in the new `source_expense_id`; `expense_id` is NULL because no live expense exists. No expense, cash movement or compensating entry was recreated. Four other audit rows resolve to existing imported expenses. A missing expense without DELETE evidence causes preparation to fail.

The original singleton `construction_settings` is preserved as an owner-only source-evidence context, not applied to global test settings. Its source accounting start is 2026-10-01, while the existing test setting remains 2026-10-29 with the original test approver. Historical authors/responsible parties were preserved through identity links without activating or appointing anyone.

## Database safeguards

Migration `20261127062434_company_project_legacy_stock_import.sql` adds source-batch markers and immutable-history triggers to the eight construction tables. The Stage 34 invoker verifier requires PostgreSQL owner context, a matching transaction-local batch and an existing batch from the known source. Service-role inserts cannot forge imports. UPDATE cannot attach/remove/change an import marker; imported rows cannot be changed or deleted. Native rows keep their existing behavior and construction triggers.

The audit's native NOT NULL rule is maintained by a CHECK: an absent live expense is accepted only with both an owner-verified source batch and an explicit original source expense ID. Native audit rows still require a non-null expense ID and cannot supply source provenance. The archived settings table in private `tozon_import` has RLS and no PUBLIC/anon/authenticated/service-role access.

Identity columns are populated with `OVERRIDING SYSTEM VALUE` to retain original document numbers and remapped ledger IDs. Their sequences are advanced monotonically after import, allowing later native records to receive new numbers. No construction trigger was disabled and the existing document-number uniqueness remains in place.

## Verification

- Four focused PGlite tests cover original identity-number preservation and subsequent native numbering, read-only imported stock and immutable markers, native versus source-deleted expense audit rules, service-role forgery rejection with ordinary catalog writes still allowed, private-context denial, and production-destination rejection.
- A typed local rehearsal loaded all 90 real rows. It used current target construction column types, identity columns, checks, unique/FK constraints and both existing construction-document triggers. Previously verified user/project/party IDs served as parent anchors; all 1,225 current cash rows were cloned exactly for hash verification. This was not a complete application clone.
- The hosted import ran atomically, checking required prior mappings, the original warehouse baseline, every inserted projected value/count and absence of changes to cash/background/global settings.
- Hosted post-check: **zero payload-hash mismatches**, all 16 documents remain POSTED, all live document material references resolve, and all non-null audit expense links resolve. Six deleted-source audit rows retain three original expense IDs.
- Exact numeric net quantities and values by warehouse/material/currency match the source. Posted settlement totals match by party/currency/account. A separate read-only check also matched four combined settlement groups including the cash-derived `construction_expense_settlements` view; decimal arithmetic was used for aggregate comparison.
- All **1,225 pre-existing payments/expenses** retain their hashes. The original native warehouse, global construction settings, PKO counter and background counts remain unchanged. No SMS or tasks were generated.
- All 10 imported users remain inactive with disabled workspace registrations. No imported warehouse was bound to an employee workspace and no employee permissions were granted. All triggers remain enabled.
- Security advisors returned informational RLS-without-policy findings only; no warning/error-level security findings.

Only generic scripts, the migration and non-personal summaries are versioned. Real payload SQL, source files and detailed financial checks stay outside the repository. No application deployment was required for this database-only phase.

## Remaining work

Next: cost allocations and remaining source histories, then project-scope/date configuration, financial-report integration and final reconciliation. The Stage 34 active payment without a source transfer master remains unresolved and untouched. Copying source stock/settlement balances does not certify the correctness of source accounting or launch readiness. Imported warehouses and historical projects remain outside ordinary employee workspaces. Project directors, real staff access and production activation have not been inferred. A final source delta remains required before cutover.
