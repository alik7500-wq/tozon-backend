# Stage 30 — source CRM inventory and offline import map

## Scope and result

The user selected the live CRM as the source for existing staff, roles, desks, warehouse and accounting history. Read-only queries ran against `yeslzrrcwgcqfxhgbrqk`; target metadata came from the isolated test project `yaolkwbnhnacxxjpgiyu`. Neither database was modified in this stage.

The repeatable source query is `scripts/company-project-source-preflight.sql`. The offline planner is `scripts/company-project-import-plan.mjs`; its generated, non-executable plan is `docs/qa/company-project-stage30-import-plan.json`. The plan contains source IDs and role codes, without contacts, passwords, credential hashes or customer documents. Real access is not enabled by this file.

## Inventory at 2026-11-26 18:45:47 UTC

| Source table/category | Records |
|---|---:|
| Users | 10 |
| Units, all kinds | 330 |
| Deals, including cancelled/reserved | 103 |
| Payments, including voided | 491 |
| Expenses, including voided | 733 |
| Construction documents | 16 |
| Active cash-desk definitions | 9 |
| Warehouses | 1 |

Source complex 3 is Plaza (A/B); source complex 4 is Plaza-2 (V/G). Signed deals: 78 and 3 respectively. Every source deal resolves to its physical complex. Cash-document references to existing deals and cash desks also resolve: zero missing references in those checks.

The warehouse's responsible party explicitly links to source user 6 (WAREHOUSE_MANAGER); all 16 POSTED warehouse documents link to source complex 3. Construction settings specify start_date=2026-10-01 and approver source user 1. This date is the existing construction accounting start, not a cutover date.

Observed deal responsibility: source user 1 has 67 deals in complex 3 and 2 in complex 4; source user 3 has 31 in complex 3; source user 11 has 3 in complex 4. Authorship/responsibility is evidence for preserving record ownership, not a new access grant. Current global user roles and explicit cash-desk rights must be translated together; a role name alone cannot establish per-project rights.

## Explicit remapping requirements

- Target users 3 and 4 are demo users. Source users with those IDs are different people and roles. All imported identities require a source-to-target map and newly allocated target IDs; no match by numeric ID or display name.
- Target physical complex 3 is demonstrative and already has two deals. It must not be overwritten or renamed as the source's real Plaza. Import the real complex under a newly mapped ID; preserve demo history.
- Keep AB and VG ledgers separate. Source cash code TOZON_PLAZA_2_CASH belongs to VG under the existing accountingScope rule. The other source desks follow the legacy AB rule, subject to full reconciliation. No new company-project ownership is guessed or activated.
- Warehouse and responsible-user IDs must be mapped together. Preserve each document's physical-complex reference.
- Template scope `3` in the current pilot means the demo complex. Imported templates need the real complex's new mapped scope, not a raw copy of the scope number.
- Existing signed contracts lacking frozen signers must retain that fact and remain blocked for snapshot-dependent document generation. Do not fill historical signers from today's director.

## Cash-history checks

The AB/VG mismatch scan found one cross-scope payment, already VOIDED; zero ACTIVE mismatches were found by that scan. Preserve the voided record and its history, while excluding it from balances. This result does not certify all cash ownership or balances.

Across payment/expense rows, 224 distinct conversion IDs and 14 distinct transfer IDs were observed. These are counts of referenced groups, not proof of complete masters, paired legs or balanced amounts. Import must preserve original currencies, rates, amounts, operation types, group IDs, statuses and all related legs. Do not turn raw sums into opening balances or convert historical figures at today's rate. Barter and transfer semantics still require full graph reconciliation.

## Validation and next executable step

- The source inventory SQL executed successfully against the selected source.
- Three focused offline-planner tests passed: identity collisions/access retention, AB/VG and voided handling, and rejection of duplicate/incomplete input with unresolved unknown scopes.
- Generated plan identifies user collisions [3,4], physical-complex collision [3], and zero active AB/VG cash mismatches.
- Inventory grouping totals match the full source counts for 330 units, 103 deals, 491 payments and 733 expenses.

Next: export the complete dependency graph into a separate staging dataset, allocate identity maps, preserve frozen source values, and validate row counts/hashes and financial relationships before any import is applied. The current artifact is a preflight map, not a backup, full data export, executed migration or launch approval. No deployment is needed for these offline files.
