# Stage 24 — Daily project cash balances

## Scope and delivery

Frontend runtime `6bedb2a146ace216ea33d44ce6da943b519ccb61`, branch `feature/company-projects-foundation`.
Test static deploy `dep-dbtdvvh5efls73aros20` reached `live` on this commit; automatic deployments remain off.
Only the isolated test static frontend is redeployed. Existing Stage 22 API and RPC, membership/permission checks and 5000-document completeness guard are reused unchanged. No migrations, dependencies, financial rows, cash-desk mappings, grants or production settings are changed.

## Behavior

Finance → Cash book → choose dates → Show daily balances. The expandable daily table shows date, currency, opening, income, expense and closing. Dates are ascending; same-day documents are aggregated before carrying the balance to the next date. Each currency has an independent carry. Only dates with active recorded movements are shown; the UI explicitly explains that days without movements retain their previous balance. A period containing only prior balances shows an explicit no-movement message rather than invented daily transactions.

The table is derived from the complete scope-checked book, before journal direction filtering or journal pagination. The currency and date selectors apply; the journal's Income/Expense selector does not remove the opposite direction from balances. Daily pagination is separate, with 100 rows per page; all opening/carry calculations happen before slicing. A new desk, currency or date range resets the daily page. Negative daily closing balances are highlighted.

The existing BigInt-cent projection now returns daily balances alongside period totals. No floating-point money arithmetic or current FX conversion. Prior history initializes each currency's opening; both period boundaries are inclusive; voided/inactive rows and later dates are excluded. Malformed active history returns no partial daily table. The whole-book reconciliation gate suppresses daily reports when cash/FX/transfer/barter interpretation is ambiguous. Existing loading, scope changes and access failures hide previous financial data.

## Validation

- Selected workspace, pricing, update and build-version suites: **92 tests / 18 files passed**.
- Added deterministic coverage for reverse input order, multiple same-day income/expense documents, interleaved currencies, prior opening balance, inactive/later records, negative/very large exact balances, no-movement periods, more than 100 daily dates, and agreement of first/last daily balances with period opening/closing.
- UI tests cover expanding/collapsing, direction-filter independence, no-movement explanation, separate daily/journal pagination and page reset after changing period.
- Changed-file oxlint, flagged production build and git diff --check passed. Existing large-bundle build warning remains. Backend tests were not rerun because the backend is unchanged; the unsafe legacy repository-wide npm test was not attempted.

## Live browser verification

Existing test employee Plaza at the normal test URL, manager cash desk, existing payment #51 from 12.11.2026:

- Period 01–30 November: daily row 12.11.2026, USD, opening 0.00, income 680.00, expense 0.00, closing 680.00; agrees with period totals and the original PKO.
- Selecting Expense hides the PKO from the journal but preserves the full daily row and its 680.00 closing balance.
- Period 13–30 November: period opening/closing 680.00, zero income/expense, daily section explicitly says no movements and unchanged balance.
- Final review page restores the whole November period and all journal movements. [Browser screenshot](qa/company-project-cash-daily.png).

Only one real test movement exists, so multi-date, multi-currency, pagination and negative-balance cases were exercised in isolated fixtures rather than fabricated persistent transactions.

## Limits

This is a projection of recorded history, not physical cash reconciliation. Complete opening balances and historical entries remain a prerequisite. The report intentionally omits calendar days without movement. Legacy mixed-currency reconciliation, cash corrections/refunds and production rollout remain separate work.
