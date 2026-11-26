# Stage 33 — hosted-test customers, contracts and schedules

## Applied data batch

Only the isolated test destination `yaolkwbnhnacxxjpgiyu` was modified. The source is the existing Stage 31 consistent snapshot at 2026-11-26 18:52:38 UTC, not a fresh production cutover snapshot.

Batch `25b2a940-dbc6-471b-9d84-5991ce4c1f4b` committed at **2026-11-26 20:32:28 UTC** (2026-11-27 01:32:28 Asia/Karachi).

| Imported table | Rows |
|---|---:|
| leads (customers and prospects, preserving their source status) | 96 |
| marketing_partners (required parent of 26 source deals) | 1 |
| deals | 103 |
| deal_payment_schedules | 2,731 |
| **Total** | **2,931** |

Deal statuses remain 81 SIGNED, 7 RESERVED and 15 CANCELLED. Original contract numbers, dates, amounts, currencies, rates, buyer/manager/unit links and graph references were retained, using the Stage 32 catalog identity map. No new customer stage, sale status, payment, current-director snapshot or contract-closure snapshot was inferred.

## Historical numbering and owner-only import

Migration `20261126203148_company_project_legacy_contract_import.sql` introduces a source-batch namespace for imported contract numbers. Existing native contracts remain uniquely numbered in their native namespace, while each imported batch enforces its own number uniqueness. This permits an original historical number to coexist with the same demo number without changing either.

An imported deal requires the PostgreSQL owner, a matching transaction-local import batch setting, an existing source batch, an original number and absent invented project/signer/closure snapshots. The import marker cannot be attached, removed or changed by a later UPDATE. Ordinary service-role inserts cannot forge an import, even by setting the transaction variable. The owner import is not exposed through an application endpoint or RPC.

The existing numbering trigger preserves verified imported numbers; native numbering continues normally. The existing deal SMS trigger skips verified historical INSERTs, so loading old signed/reserved contracts does not generate customer messages. All triggers remain enabled; there is no replication-mode bypass. Missing marketing-partner and confirmer foreign keys were also added.

## Verification

- Three PGlite mechanism tests passed: duplicate historical/native number coexistence with no SMS, imported-number uniqueness and marker immutability; rejection without owner context and under a forged service-role context; native numbering and rejection of invented signer facts.
- A typed local rehearsal loaded all 2,931 real snapshot rows, reusing the previous catalog batch and enforcing target column types, checks, unique/FK constraints and active numbering/SMS triggers.
- The hosted transaction verified each count and projected value, all 666 catalog identity-map entries, and hashes of 68 pre-existing customer/deal/schedule rows before and after insertion.
- Hosted post-check: all 2,931 ledger entries present; zero missing buyer/unit/responsible-user links; zero invented signer, closure or company-project snapshots.
- Exact numeric totals of deal prices by currency/status, schedule amounts and schedule paid amounts match the original source snapshot. No JavaScript floating-point conversion was used for monetary payloads.
- Background counts remained SMS events=0, SMS messages=0, tasks=0, notifications=1. Cash counts remain payments=1 and expenses=0, both pre-existing pilot data.
- Security advisors returned only informational RLS-without-policy entries for the deliberately closed browser access. No warning/error-level security findings were returned.

## Remaining work

No production data, production configuration, staff grants or external service connections were changed. No app deployment was needed for this database-only stage. The generic scripts and summary are versioned; row-bearing SQL and personal/financial snapshots are not committed to GitHub.

Imported complexes/customers/deals remain outside ordinary employee workspaces until project ownership and complete financial history are ready. Schedule paid amounts were preserved as historical values; this does not mean the corresponding cash history has already been loaded or balances certified. Next: import cash-desk definitions and full payment/expense/transfer/conversion/barter dependencies, then stock/settlement and remaining histories, with reconciliation before enabling access. A final source delta is required before production cutover.
