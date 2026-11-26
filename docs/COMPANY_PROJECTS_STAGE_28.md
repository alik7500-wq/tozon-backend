# Stage 28 — Login cache policy and Plaza isolation audit

## Delivery

On 2026-11-26, added the exact `/login` → `Cache-Control: no-store` rule to the existing test static service in `deployment/project-pilot.render.yaml`. Configuration commit: `ce13b2b016be8ed6dfc3ff3d8558f461cf1f1776`, branch `feature/company-projects-foundation`.

The Render dashboard browser attempt timed out. The existing, previously configured test-only Blueprint was recovered from project documentation and verified through the connector: `exs-dbqajgl9fdbs73c3mefg`, the same feature branch and configuration path, automatic syncing off, and only the two existing test resources. No new Blueprint or resource was created.

Render plan `exe-dc47ep8u01pc73f3nbs0` proposed exactly one `UpdateHeaders` action for `tozon-crm-commercial-test`: retain the four existing no-store rules and add `/login`. No API, plan, environment-variable, permission, or route change was proposed; no manual secrets were required. This reviewed change was applied within the user's instruction to continue the login-cache step. [Render sync](https://dashboard.render.com/blueprint/exs-dbqajgl9fdbs73c3mefg/sync/exe-dc47ep8u01pc73f3nbs0).

The first response after approval still showed the previous cache policy. Subsequent verification of the ordinary `/login` URL without a cache-busting parameter returned HTTP 200 and `Cache-Control: no-store` at 18:17:43 UTC. A new Render plan returned `planningOutcome: no_changes`, confirming no remaining configuration difference. Blueprint automatic syncing remains off. The YAML passed current Render public JSON Schema validation; no Render CLI validation is claimed.

## Test Plaza readiness and authorization

Only test database `yaolkwbnhnacxxjpgiyu` was queried, with the existing read-only readiness and workspace readers. No hosted data, grants, memberships, or financial records were changed.

- Plaza revision 5: director and authority fields present; two partners totaling 100%; one mapped active complex; two active cash desks; one active warehouse.
- No detected deal, payment or expense project-scope conflicts. No missing active CONTRACT/SCHEDULE RU/TJ template combinations for the mapped complex. The document bucket exists and is private.
- Existing test employee 4 is active, project-only, enabled in the roster and granted access. The workspace reader lists only Plaza and returns its two demo units. A direct read of Tower units using this employee was rejected with SQLSTATE 42501 / WORKSPACE_ACCESS_DENIED.
- The workspace RPC is not executable by anon or authenticated. The readiness RPC is not executable by anon. All five checked project-mapping/access tables have RLS enabled and deny direct SELECT to anon and authenticated.
- Scoped server suite: **259 tests / 30 files passed** using local PGlite and mocks: `npx vitest run src/modules/company-projects src/pilot --fileParallelism=false`. This does not execute legacy production-connected tests.

Evidence: [HTTP headers](qa/company-project-stage28-headers.json), [readiness and isolation](qa/company-project-stage28-isolation.json).

## Limits and next launch gates

These hosted authorization checks invoke RPCs through privileged database tooling with the existing test actor; they do not constitute a new authenticated browser/HTTP role test. The current browser check of the Render dashboard failed, and no new screenshot is claimed. The prior Stage 27 calculator/update browser evidence remains separate.

Present director/authority fields and a partner total of 100% do not verify the real legal appointments or the correctness of partner identities and shares. One configured demo employee does not verify every future director, cashier, manager and warehouse role. Before a production cutover, confirm those assignments, inspect rendered/printed RU/TJ forms and attachments, reconcile opening balances and legacy record ownership, and approve a backed-up migration/cutover plan. The currently mapped complex and units are demonstrative test data, not proof of a migrated real Plaza inventory.

Production and main branches were not changed. No API or frontend application rebuild was triggered in this stage. This is completion of the exact login-cache fix and the documented test Plaza technical checks, not a production launch declaration.
