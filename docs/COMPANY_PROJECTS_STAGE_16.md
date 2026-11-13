# Stage 16 — Scoped apartment pricing preview

Delivered to the isolated test CRM on 2026-11-14 (Asia/Karachi). Production, historical contracts, grants and discount-scheme records were not changed.

## Implementation

- Inventory RPC now includes only active, date-valid discount schemes for the selected authorized physical complex. Existing fresh project inventory authorization and explicit inventory projection remain intact. No global discount-scheme or finance routes were opened.
- Extracted the existing calculator into a network-free ApartmentPricingView. The legacy loader remains in ApartmentPricingCalculator; the project workspace imports only the pure view.
- Apartment details now include pricing tiers, comparison, custom deposit/percentage and term inputs. Same-percent offers retain independent rule keys. Banner rows are grouped by installment duration; full payment spans all term rows at the end. Comparison rows follow the same duration grouping.
- Manual reference USD/TJS rate is explicitly labelled as manually entered, not as a bank rate. Typed TJS deposits are recalculated when this rate changes; missing/invalid rates disable TJS entry and suppress amount-based quotes. Posted transaction exchange rates remain separate.
- Quote selection, raw typed TJS amount and reference rate are retained across the existing periodic access refresh; current data and permissions are still rechecked.
- The preview does not sign, reserve, save a price, post a payment, or generate/send an offer document. Existing authorized operation forms remain separate.

## Validation

- 246 backend tests across 29 files passed, including active/expired/future/foreign-complex scheme filtering, live rule updates and distinct 36/40-month rules.
- 67 frontend tests across 15 files passed; an additional reload-preservation case was then added and its 5-test inventory suite passed, including existing legacy pricing flow tests and new project calculator tests (no legacy calls or writes, grouped cards/comparison, add/remove conditions, manual rate conversion).
- Changed JSX lint passed. Pilot frontend build passed; existing large-chunk build warning remains.
- Migration 20261113192434_company_project_inventory_pricing.sql applied only to test project yaolkwbnhnacxxjpgiyu. Real read for employee 4 returned the two own demo units and schemes=[]; there are currently no discount schemes in this test database. No demonstration offers were invented or inserted.
- Security advisor reported only the existing INFO rls_enabled_no_policy notice for server-only tables. Reference: https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy.

## Source and deployment

- Backend migration/test commit 729e7ea0940eb55402452898fefb721ab4b1e44e. API code did not change and did not require redeploy; its existing inventory endpoint returns the upgraded RPC result.
- Frontend commit 172ccb172cc20ae08a22ae9dba858ab5e8cc1d34, Render dep-dbrmb2u7bikc73avfsgg verified live.
- Both repositories use feature/company-projects-foundation. No main merge. Test static site auto-deploy remains off.
- Browser build verified at /?_crm_reload=172ccb1-live, avoiding previously observed stale root assets. Durable cache fix remains separate.

## Browser proof

Existing Plaza test employee opened demo apartment 101 (60 m² at 600 USD/m²). With illustrative manually entered rate 10 TJS/USD, deposit 100000 TJS and term 36 months, preview showed total 36000 USD, down payment 10000 USD, balance 26000 USD and monthly 722.23 USD. The manual rate is a QA input, not a current bank quote.

Screenshot: qa/company-project-pricing.png. A prior browser pass lost the selected card; one repeat timed out. Its exact trigger was not established. The subsequent calculator screenshot shows the entered values, and the dedicated automated authorized-reload test passes, but the full browser reload-preservation scenario is not marked conclusively verified.

## Remaining scope

The test project is still mapped to the demonstration complex. Real Plaza inventory/schemes were not copied. Photos, plans, showroom and offer-document generation are not yet ported. Word download verification from Stage 14 remains unconfirmed.
