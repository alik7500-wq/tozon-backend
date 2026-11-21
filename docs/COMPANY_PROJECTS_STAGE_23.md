# Stage 23 — Cash-book period opening and closing balances

## Delivery and scope

Frontend runtime: `776e9f199a1fa60a5b44cf9ca8c0a1eb644e7a67` on `feature/company-projects-foundation`.
Test static deploy `dep-dbtdpbgae00c73af95kg` reached `live` on that commit. Automatic deployments remain off.
Only the isolated test static service is redeployed. The existing Stage 22 API runtime and read-only cash-book RPC are reused. No database migration, dependency, grant, business row, posting algorithm or production configuration changes.

## Behavior

Finance → Cash book now adds a period table when either date boundary is supplied: currency, opening balance, income, expense, closing balance. Opening includes all active movements strictly before the start date. Period movements include both boundary dates; movements after the end are excluded. An absent start means the beginning of recorded history; an absent end means all subsequent recorded dates, explicitly labelled in the UI. Each currency remains separate. Reset period clears both boundaries.

The calculation uses the complete authorized book returned by the existing scope-checked, bounded RPC, before visible journal pagination or direction filtering. A currency selector narrows the period currencies; the income/expense direction selector affects only the journal and cannot manufacture a misleading balance. All-time totals remain separate and explicitly labelled.

Money is converted from exact two-decimal strings to BigInt cents for additions/subtractions, then returned as exact two-decimal strings. No floating-point money arithmetic or current exchange-rate conversions. Cancelled/voided/inactive records are excluded by the server-provided active marker. A malformed active date/amount/currency/direction stops the whole period projection with a reconciliation message, rather than producing a partial result. Calendar dates, including Gregorian leap-year rules, are validated without local time-zone conversion.

The existing whole-book reconciliation gate remains authoritative: legacy transfers, FX, bank/barter/ambiguous settlement or unknown statuses suppress period balances as well as all-time balances. Loading, desk change, failed access and source refresh hide prior period data through the existing read hook.

## Automated validation

- Selected workspace, pricing, update and build-version suites: **88 tests / 18 files passed**.
- New money/date tests cover prior income and expense, inclusive boundaries, later-document exclusion, separate currencies, open-ended dates, zero-activity periods with carried balances, more than one visible page, exact very large values, negative balances, cancellation to zero, impossible dates and malformed active history.
- UI coverage verifies carried balances, the independence of direction filters, currency filtering, reset, no partial totals on invalid history, reconciliation gate, and hiding old period data during desk switching/access failure.
- Final changed-file oxlint, flagged production build and git diff --check passed. Existing large-chunk build warning remains. No repository-wide backend npm test was attempted in this stage.

## Browser validation

Existing signed-in test employee Plaza, assigned manager cash desk, existing payment #51 (12.11.2026, 680.00 USD):

| Period | Opening USD | Income USD | Expense USD | Closing USD |
| --- | ---: | ---: | ---: | ---: |
| 01–30 November 2026 | 0.00 | 680.00 | 0.00 | 680.00 |
| 13–30 November 2026 | 680.00 | 0.00 | 0.00 | 680.00 |

The second period correctly has an empty journal but retains the earlier payment as opening balance. The Expense direction filter hides the income row for the first period without changing period totals. The final page shows all movements and the November summary. [Browser screenshot](qa/company-project-cash-period.png).

## Limits

This is an informational report of recorded cash-book history, not a physical cash count. Correct opening balances require complete historical entries. The server's existing 5000-document refusal still prevents silent truncation; this stage does not introduce a period endpoint to bypass that limit. Legacy FX/barter reconciliation, daily running balances, corrections/refunds and production rollout remain separate.
