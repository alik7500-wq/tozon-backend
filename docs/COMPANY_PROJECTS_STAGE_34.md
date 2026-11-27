# Stage 34 — preserved cash history in isolated hosted test

Only `yaolkwbnhnacxxjpgiyu` was modified. Source data came from the existing Stage 31 snapshot of `yeslzrrcwgcqfxhgbrqk` at 2026-11-26 18:52:38 UTC. No production write or new source snapshot was made.

Batch `c20275b9-4773-43e8-a210-b9fa7bf9640d` committed at **2026-11-26 21:04:03 UTC** (2026-11-27 02:04:03 Asia/Karachi).

| Imported table | Rows |
|---|---:|
| dictionaries (including 9 original cash-desk definitions) | 62 |
| construction_parties | 4 |
| expenses | 733 |
| payments | 491 |
| cash_transfers | 13 |
| barter_realization_results | 2 |
| **Total** | **1,305** |

## Preservation and import controls

Migration `20261126205613_company_project_legacy_cash_import.sql` adds an immutable source-batch marker to the four cash/transfer/barter tables. Imported rows require `current_user=postgres`, a matching transaction-local batch and an existing batch from the known source CRM. UPDATE cannot attach, remove or replace the marker. Imported cash rows are read-only, including deletion; later correction or operational activation requires a separate reviewed implementation.

Native document numbers and customer PKO numbers retain their original unique namespace. Each imported batch has its own unique namespace, permitting original historical numbers to coexist with demo numbers. Historical INSERTs retain original dates, numbers, statuses, amounts, currencies, exchange rates and idempotency keys. Existing numbering, payment SMS and derived expense-settlement audit hooks recognize verified imports and do not renumber, send historical notifications or generate fresh settlement history. All triggers remain enabled. Normal native numbering/SMS behavior is covered by a service-role regression test.

The source has one employee settlement, which the older test schema did not support, and a settlement predating the test's accounting start date. These are preserved solely as verified immutable source history. Native settlement validation and allowed account types remain unchanged. Global construction settings and the native PKO counter were not altered.

Declared FK links use the established identity map. Undeclared `payments/expenses.voided_by` and `transfer_id` fields are remapped in a temporary import projection; the original export and staging store are unchanged. Nested immutable barter/audit JSON remains an original-source snapshot and retains source identities. There were no missing declared parent records or missing voiding users.

Generated barter result columns are computed by PostgreSQL, excluded from INSERT columns and included in exact post-insert comparisons against the source. An initial hosted attempt encountered the generated-column restriction and rolled back atomically, leaving the prior cash baseline unchanged; the typed rehearsal was corrected to model generated columns before the successful import.

## Source issue retained for reconciliation

There are **14 transfer UUID groups and 22 linked cash legs**, but only **13 master transfer rows** in the source snapshot. One **ACTIVE** incoming payment references a transfer master absent from that same source snapshot. The leg and its source status were retained, with a deterministic historical group identity; no transfer master, outgoing leg, cancellation or balancing entry was invented. This is an unresolved source-data issue and prevents declaring cash balances certified. It is separate from the previously recorded VOIDED Plaza-2/AB-desk mismatch.

All **224 conversion groups / 659 conversion legs** remain present. Per-row equality and numeric aggregate checks establish faithful copying; they do not establish that historical accounting was correct or every transfer was complete.

## Verification

- Four focused PGlite tests passed: historical/native numbering coexistence, source-number uniqueness and immutable history; forged import rejection with ordinary service-role numbering/SMS still working; preservation of the employee settlement without new audit rows while native equivalents are refused; production-destination rejection.
- A typed local rehearsal loaded all 1,305 real snapshot rows, including generated barter columns, target cash checks/unique/FK constraints and active cash triggers. Parent rows were typed anchors from the previously checked catalog/customer batches; this was not a full application clone.
- The hosted import ran as one transaction, checking required prior identity-map entries, pre-existing cash/dictionary hashes, exact projected values for every row, row counts and absence of background/counter/settings changes.
- Hosted post-check found **zero payload-hash mismatches**. Exact PostgreSQL numeric sums of `amount_minor` by table/currency/status match the original source snapshot; monetary payloads never passed through JavaScript floating-point numbers.
- Three native cash/dictionary baseline rows retained their hashes. PKO counter remains 1 and construction settings retain their original values.
- Background counts remain SMS events=0, SMS messages=0, tasks=0, notifications=1, settlement audit=0. No triggers were disabled.
- All 10 imported users remain inactive with disabled project workspace registrations. No imported cash desk was added to a company-project workspace and no employee permissions were granted.
- Security advisors returned informational RLS-without-policy findings only; no warning/error-level security findings.

Generic code, migration and this non-personal summary are versioned. Real row-bearing SQL, source files, hashes and detailed financial verification stay outside the repository. No application deployment was needed for this database-only stage.

## Remaining work

Next: stock, construction/settlement and remaining source histories, followed by project ownership and balance reconciliation. The legacy finance scope helper still contains original source UUID/project-ID constants; remapped identities must be connected through the project registry before enabling financial reports. Imported historical complexes/deals/cash desks remain outside ordinary employee workspaces. Do not infer directors, activate employees, merge AB/VG cash scopes, certify balances or enable production from this import. A final source delta is required before a working cutover.
