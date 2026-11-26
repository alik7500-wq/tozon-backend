# Stage 32 — hosted-test catalog import

## Applied to the isolated test project

Destination: `yaolkwbnhnacxxjpgiyu`. The source remains the consistent Stage 31 snapshot of `yeslzrrcwgcqfxhgbrqk` at 2026-11-26 18:52:38 UTC. Production was not modified.

The catalog transaction committed at **2026-11-26 20:17:11 UTC** (2026-11-27 01:17:11 Asia/Karachi), batch `d83bc220-176a-4497-a4ac-e45095b4aeb3`.

| Imported category | Rows |
|---|---:|
| Physical complexes | 2 |
| Buildings | 4 |
| Sections/entrances | 4 |
| Floors | 44 |
| Layout types | 56 |
| Layout rooms | 165 |
| Layout features | 47 |
| Units, including parking and commercial | 330 |
| Discount schemes | 4 |
| Disabled, project-only user identities | 10 |
| **Total catalog/identity rows** | **666** |

The missing CASHIER role was copied from the source role snapshot with `is_active=false`; existing role definitions were left unchanged. Imported user identities have unusable password placeholders, `is_active=0`, the `company.project-only` marker, and disabled workspace registrations. No project memberships, section grants or cash-desk grants were created for them.

## Compatibility migrations

- `20261126190623_company_project_import_compatibility.sql`: four missing sales-history/marketing tables; missing source columns; a private owner-only import ledger. New tables use RLS, deny browser-role reads and permit only server operations where needed.
- `20261126201656_company_project_import_parking_area.sql`: permits NULL area only for PARKING. Existing positive-area checks remain, and apartment/commercial area remains mandatory. This preserves 30 Plaza-2 parking spaces whose area was never recorded in the source.

Files are aligned with actual hosted migration-history versions. Both were created through the CLI before applying; only the test project was selected.

## Import controls and validation

Generic SQL generator: `scripts/company-project-catalog-import.mjs`. Local typed rehearsal: `scripts/company-project-catalog-rehearsal.mjs`. Real row-bearing SQL and target baseline snapshots remain outside GitHub.

The transaction uses explicit source columns and already remapped IDs; verifies every inserted count and projected row value; checks hashes of all eight pre-existing demo catalog/user rows before and after insertion; rejects repeated batch IDs; registers source-to-target identities; and checks background counters before commit. Existing triggers and constraints stay enabled. UTC is selected within the transaction so timestamp JSON comparisons use the source snapshot representation.

- Typed local rehearsal against target column types, nullability, checks, unique and foreign-key constraints passed for all 666 rows.
- Three focused catalog tests passed: destination/table/credential gates; transactional safety assertions; parking NULL-area compatibility while rejecting missing apartment/commercial or negative area.
- Hosted verification found all 666 import-ledger entries, ten inactive users, zero missing project-only markers, zero enabled imported workspace registrations, and all 30 expected NULL parking areas.
- SMS events=0, SMS messages=0, tasks=0, user notifications=1 before and after. Existing financial counts stayed at deals=2, payments=1, expenses=0.
- All six new public/private tables have RLS enabled and no anon/authenticated SELECT grants. Security advisors report informational RLS-without-policy entries, consistent with the deliberately closed browser access; no warning/error-level security findings were returned.

## Remaining work and recovery

This imports the catalog into real hosted-test application tables. Imported complexes remain unbound to company-project workspaces, so ordinary project users do not yet see them. No frontend/API deployment was needed. Original demo history, original template scopes and singleton settings remain intact.

Client/deal/schedule/cash/warehouse/resettlement history has not been imported to hosted business tables yet. The Stage 31 private archive retains the complete selected 63-table source snapshot. Next, the financial adapter must reuse this batch's ID maps, preserve source document numbers without conflicting with demo contracts, map project and cash ownership separately for AB/VG, retain voided history and conversion/transfer groups, and preserve missing historical signer facts.

Do not replay this catalog batch or reuse offline staging IDs for unrelated records. `tozon_import.rows` is the authoritative map for this import. Any rollback must use its exact batch and target IDs, check for subsequent edits/dependencies, and remove only imported dependent rows in reverse order. No rollback or cleanup was executed.
