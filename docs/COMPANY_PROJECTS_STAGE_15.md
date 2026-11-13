# Stage 15 — Scoped apartment chessboard

Implemented in the isolated commercial test environment on 2026-11-13. Production, existing business records and user access grants were not changed.

## Delivered

- The project workspace's "Помещения" section now offers a complete chessboard and list view for one assigned residential complex.
- Groups by block and entrance; floors descend from highest to lowest including basement/parking levels. Cells retain server position ordering, status labels/colors, room counts and area.
- Complex selector includes only active complexes mapped to the current company project. Filters cover status, unit kind, actual room counts and number/block/entrance search over the entire selected complex.
- Read-only unit detail shows hierarchy, area, base price and any fixed price. It deliberately makes no legacy customer, document or sales API requests. Existing authorized project operation forms remain separate.
- New server-only SECURITY INVOKER function read_company_project_inventory(integer,uuid,integer), fresh actor/roster/membership/permission checks, strict route query validation and explicit projection. Archived hierarchy is excluded. Foreign complex IDs return 404. The function rejects more than 5000 units instead of silently displaying a truncated board.
- A browser check found that periodic access refresh unmounted the workspace and reset filters. Navigation context now persists only during same-actor refresh; record data still clears while fetching and access denial/actor changes clear the workspace. Chessboard selection/filter state survives refresh.

## Source and deployment

- Backend: 275d2c2d81184fb38afcda661c273cd4df583261, live dep-dbrjubrrjlhs73bgobc0.
- Frontend: initial 97a4962309386ce851d06774b00e1dbedd71a3e5; refresh fix cab509e40105eb7baa61a63c1282338b9a2c589f, live dep-dbrk05d6e07s73bv0s6g.
- Test migration 20261113164153_company_project_inventory_board.sql applied only to yaolkwbnhnacxxjpgiyu.
- Branch feature/company-projects-foundation, no main merge; both test services retain auto-deploy off.

## Verification

- 245 backend tests across 29 files passed, including ten inventory SQL tests and authenticated route validation.
- 49 frontend tests across 11 files passed. The changed page integration suite was rerun after adding refresh preservation assertions (8 tests passed).
- Production frontend build with pilot flags and changed JSX/hook lint passed. Existing large-chunk build warning remains.
- Real test SQL for the current Plaza employee returned only the assigned demo complex and two sold apartments (101, 60 m²; 102, 80 m²), without customer fields.
- Real browser confirmed chessboard, list view, room filter and base-price detail under the existing Plaza test employee session. After more than 39 seconds, the room filter remained 2 and the selected unit detail was still visible, confirming state preservation across periodic refresh. Final screenshot: qa/company-project-chessboard.png.
- No error-level API logs were returned for the checked post-deploy interval. Security advisor returned only existing INFO RLS-without-policy notices for server-only tables; no new warning/error reported. Reference: https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy.

## Limits and follow-up

This is an inventory viewing module. Photos, 2D/3D plans, 360 tours, price-offer calculator, inventory editing and showroom have not been ported into this scoped detail yet. Signing and payments continue through the previously authorized project operations.

The test Plaza remains mapped to the demonstration complex, not production Plaza inventory. No historical deals were modified. Successful Word download is still unconfirmed from Stage 14.

Browser root reloads still received older static assets after successful deploy; the current build was verified with /?_crm_reload=cab509e-live. This workaround does not constitute a durable cache-policy fix.
