# Stage 31 — consistent core export and offline PostgreSQL staging

## Completed

The selected live CRM source was read in a single SQL statement snapshot at **2026-11-26 18:52:38 UTC** (23:52:38 Asia/Karachi). No live or hosted-test data was changed.

The export covers **63 related core tables and 6,519 rows**: catalog/layout/media metadata, users/roles, leads, deals/schedules/history, cash documents/desk rights/transfers, barter, construction stock/settlements/costs, resettlement, and contract template/settings records. Foreign-key parent closure was included in the schema inventory. Three tables are empty and retained as empty arrays.

| Check | Result |
|---|---|
| Source table payload checksums | All 63 MD5 values match the source response; SHA-256 recorded per file |
| Source rows loaded into local PostgreSQL staging | 6,519 |
| Staged rows after ID remapping | 6,519 |
| Declared foreign-key constraints checked | 139 |
| Missing declared source references | 0 |
| Missing declared staged references | 0 |
| Non-reference business-field changes | 0 across all 63 tables |
| Conversion groups / participating legs, source | 224 / 659 |
| Conversion groups / participating legs, staged | 224 / 659 |
| Enabled users in staged copy | 0 |
| Application business-table import | Not performed |

## How staging preserves data

`scripts/company-project-staging.mjs` uses local PGlite (PostgreSQL). Original exported JSON text is checked before insertion; monetary numeric values are handled by PostgreSQL JSONB without passing through JavaScript floating-point parsing. Original source payloads remain alongside the staged payloads.

Integer/UUID primary keys receive separate staging values. Declared foreign keys are remapped using original row identities and the corresponding parent staging values; repeated passes handle dependent/composite reference chains. Conversion UUIDs lacking a master-table FK receive one deterministic mapping shared by payment and expense legs. All users in the staged copy are disabled. Non-reference values, including amounts, rates, dates, status, original audit snapshots and signer data where present, remain unchanged.

The identity map is **for the offline dataset only**. It does not reserve IDs in the hosted application and must not be copied there without a destination mapping transaction.

## Saved export package

`TOZON_CRM_staging_2026-11-26.zip` was saved for the user. It contains 63 original JSON table files, the schema and source manifest, checksums, remapped JSONL, an identity map, staging checks and usage notes. ZIP integrity passed; size 627,076 bytes; SHA-256:

`aea0aef5e4401b30a04a161bdf421d454e02116c1ba88ed0a587a29975b17363`

The package contains business/customer data and is not committed to GitHub. Only generic scripts, tests and this non-personal summary are committed.

## Validation

Seven focused tests passed across the offline import planner and staging engine. They cover identity collisions, AB/VG separation, voided-record treatment, invalid/incomplete inputs, credential rejection, corrupted checksums, source-orphan reporting, and exact high-precision monetary preservation during relational remapping.

The actual export was loaded and remapped locally; the reported counts and foreign-key checks are from that dataset, not synthetic fixtures. Additional queries confirmed conversion-group counts/legs and zero active staging users.

## Remaining boundary before hosted import

- References embedded in immutable JSON history remain original source references. Undeclared relational fields and nested references need explicit destination mapping where consumed by the application.
- External file bytes, private object downloads, integration connections, sessions and user password hashes are excluded. This is a consistent **core data export**, not a full backup of all CRM services.
- No hosted business tables were populated and no employee access enabled. Runtime readiness remains false.
- The target is an earlier feature-branch pilot; reconcile its schema/API with current source fields (including resettlement) before loading real data. Template scopes must follow the newly allocated physical-complex IDs, preserving demo history and historical signer facts.
- Next executable step is a versioned hosted-test import adapter with explicit schema mapping, bounded/disabled side effects and post-import reconciliation. Production cutover remains a separate step.
