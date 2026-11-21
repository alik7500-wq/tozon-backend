# Stage 14 — Familiar project CRM shell and scoped overview

Implemented and deployed to the isolated test environment on 2026-11-12. Production was not changed.

## Delivered

- Familiar TOZON sidebar, profile footer, project selector, responsive navigation and overview hero.
- Granted navigation to clients/leads, contracts, complexes, units, receipts, schedules, expenses, warehouses and internal reminders. Existing scoped commands and document dialog retained.
- Server overview aggregates all matching project records, independent of list pagination. Fields are masked by fresh project permissions. Upcoming unpaid schedules require both contracts and payment access; per-row currencies are retained.
- Page-local list search, Russian statuses and dates. No global legacy endpoints, synthetic counts or expanded user grants.

## Deployment

- Backend 31c479ea5c574c74b928dc322806b9f625ecc02c; Render dep-dbr0f3gn74is73b3ui3g.
- Frontend 3890ef161409b186560c52f90c39c0ed62ec54e5; Render dep-dbr0f46c6qcc73dio82g.
- Test migration: 20261112182809_company_project_overview.sql.
- Auto-deploy remains off. Documentation follow-up does not require redeploy.

## Verification

234 backend tests across 28 files passed, including nine overview SQL cases and route authorization. 43 frontend tests across nine files passed. Flagged production frontend build and changed JSX lint passed.

Real browser under the existing signed-in Plaza test employee confirmed the new overview (0 available, 0 reserved, 2 sold, 0 active leads), project payment rows, contracts navigation, contract 68 document metadata including frozen director, page-local contract-number search, and the assigned Plaza warehouse. Screenshot: qa/company-project-overview.png.

A Word download was attempted but the browser download wait timed out and reset the browser connection. The dialog subsequently showed no error, but successful file download is NOT confirmed. No additional signing, financial writes or business-file uploads were performed.

## Remaining limits

- This is the familiar shell plus the existing scoped modules, not a completed port of the legacy showroom, visual chessboard or full analytics.
- Browser root navigation initially received old assets after the successful deploy. The current version was verified at /?_crm_reload=3890ef1. Cache behavior warrants a separate durable fix if reproduced.
- Contract 68 has no stored contract number; UI uses its record ID as a fallback. Historical signing data was not changed.
- The test Plaza project remains attached to the demonstration complex. These are not the production Plaza totals.
- Readiness is a technical check and does not establish production launch readiness.
