# Stage 18 — Scoped customer apartment offer

## Delivery

- Frontend: `31a15f8a27aa8763a97b7b5e05809661f447e432`.
- Backend: `89d2398483e586d23232d3f361f8590389142795`.
- Branch in both repositories: `feature/company-projects-foundation`.
- Test API deploy `dep-dbrospou01pc73e61a8g`: live, exact backend commit above.
- Test frontend deploy `dep-dbrosqm7bikc73b6idkg`: live, exact frontend commit above.
- Both services retain auto-deploy off. No production deployment or main merge.

## Behavior and access

The scoped apartment calculator now opens a customer offer with Russian/Tajik language selection and a browser print / Save as PDF action. The offer displays project, complex, apartment, area, rooms, floor, current apartment status, total, deposit, balance, term, approximate monthly payment, optional manually entered reference rate and authenticated preparer. It is a preliminary calculation, not a contract or a reservation. Sold apartments retain their real sold status in the preview.

`POST /api/project-workspace/:project/offers/preview` is a read-only, rate-limited route guarded by the document feature flag, existing scoped runtime boundary, fresh roster/project checks, inventory.view and documents.print. It accepts only a strict calculation request, checks current unit area/price and scheme revision/rule, calculates authoritative amounts, and rechecks print permission after loading data. Unknown save routes remain denied. It performs no command, contract or customer write and has no external sharing action. The browser repeats authorization and current-price validation immediately before invoking print. Rejected/stale results remove the printable preview.

No database migration, service configuration, business record or user permission was changed. No production database was accessed for this stage. The existing scoped inventory and project RPCs are reused.

## Validation

- Backend: 254 tests / 30 files passed, including 7 new pure offer tests and the route/boundary test. Focused offer/router check: 20 tests passed.
- Frontend: 76 tests / 16 files passed. Changed frontend source passed oxlint; flagged production build passed. Existing bundle-size warning remains.
- Both repositories passed git diff --check and staged trees matched the fetched published commits.
- Real Chrome test as the existing scoped test employee: Tozon Plaza workspace -> Rooms -> demo apartment 101 -> manual rate 10, desired deposit 100000 TJS, 36 months -> offer opened. Verified RU and TJ contents: 36000 USD total, 10000 USD deposit, 26000 USD balance, 722.23 USD approximate monthly payment. Both languages label the rate as manual and show the actual SOLD status.
- Screenshot: [Tajik offer in the scoped CRM](qa/company-project-offer.png).

## Verification limits and next check

The print button was invoked, but native print preview and a saved PDF file were not conclusively observed. Browser control later timed out around the native print/Escape attempt; the normal offer UI remained observable through the alternate documented DOM surface. No physical print or successful PDF save is claimed. The offer tab was retained for the user. A manual browser print/save check remains before calling this flow fully verified.

The live test complex remains the demonstration complex, not the production Plaza complex. It has no active discount scheme, so the browser check used base pricing. Same-percent 36/40-month scheme variants and stale scheme/revision rejection are covered by automated tests; no pricing configuration was invented or copied. Offer history, attached plans/photos and external delivery are outside this stage. This stage does not establish production readiness.
