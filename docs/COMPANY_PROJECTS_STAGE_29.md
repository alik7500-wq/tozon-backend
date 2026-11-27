# Stage 29 — Plaza print templates and remaining launch inputs

## Completed in the isolated pilot

- Verified the four active CONTRACT/SCHEDULE RU/TJ templates for scope `3` against repository bytes before testing. All four matched.
- Rendered through the application's `documentContext` and `renderTemplate`, using synthetic buyer, passport, contact and signer values. No business deal was created.
- Inspected all eight printed pages: three pages per contract and one per schedule. Cyrillic, Tajik characters, tables, signatures and page boundaries were readable.
- Fixed duplicated section 8 numbering in both contract templates: requisites are now section 9. Added spacing before closing section 8, which visually ran into the preceding paragraph in the Russian printout. No contractual clause text changed.
- Updated the generator to preserve these corrections on regeneration; added regression checks. Focused suite: **9 tests passed**.
- Applied only the two corrected CONTRACT template files to test Supabase `yaolkwbnhnacxxjpgiyu`, scope `3`. The transaction required both original hashes to match and exactly two rows to change. SCHEDULE files were unchanged. Returned database hashes match the corrected repository files.

## Evidence

| Template | Original MD5 | Current MD5 | Bytes |
|---|---|---|---:|
| CONTRACT RU | 8460295fad532510d2fcf2be4e99171e | 8b67a1b5e1f625e41e5fc91bed97a10f | 40621 |
| CONTRACT TJ | c8f6386b9618463b8fc19174c5290e0a | f1af18bd17366051b8e4f01a7edf96fb | 41619 |
| SCHEDULE RU | f2fbffd1aa1d31681ee76f97af7b29c1 | unchanged | 37526 |
| SCHEDULE TJ | f8ad3d5d476b8ba48cf149ebec7b5064 | unchanged | 37497 |

Synthetic financial fixture: 60 m² × 600.25 USD = 36,015.00 USD; initial payment 10,804.50 USD; two later payments of 12,605.25 USD; paid 5,000.00 USD; debt 31,015.00 USD. The displayed figures reconcile. The signer comes from the deal snapshot, not the current global director. Regression tests continue to reject old signed contracts lacking that snapshot.

Rollback source: both previous contract files remain available at commit `e3ea9d3ff38c465498851c01a5dbac96e65eaa69`. Restore only the identified pilot template rows after checking the current hashes; do not alter signed deal snapshots.

## Remaining factual inputs

Only the test administrator and the test Plaza employee exist in the pilot. The user has been asked for the real Plaza employees and their roles (cashier, sales managers, warehouse keeper), including combined roles, and the opening reconciliation date. No real access assignments are inferred from a person's name or project membership.

Once supplied, prepare named project-scoped assignments and verify each role against Plaza and another project's data. Reconcile, at the agreed date, units and statuses, signed contracts and frozen signers, payment schedules and customer balances, cash balances, expenses and warehouse quantities. Investigate differences before importing or opening real access.

## Limits

This validates template content, rendering and test-database file identity; it is not a fresh authenticated browser download or a legal approval of the contract terms. The manually reviewed launch item remains open. No production deployment, production database mutation, real permissions, financial records, existing signed contracts or external integrations were changed.
