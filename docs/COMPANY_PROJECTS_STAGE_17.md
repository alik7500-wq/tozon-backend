# Stage 17 — Pricing draft recovery during background checks

Implemented in the isolated commercial test CRM on 2026-11-14 (Asia/Karachi). No production services, database records, permissions or backend routes were changed.

## Confirmed failure scenario

The page deliberately unmounts its content when a background project-context request fails, so data from an unverified context is not displayed. Inventory selection and quote input previously lived inside that unmounted component; temporary network/server errors therefore discarded the entered conditions. This is a reproducible failure path in the code, without asserting that it was the sole cause of every earlier browser timeout/card closure.

## Changes

- Lifted the inventory input draft to the current workspace actor/project: selected complex/unit, filters, view, reference rate and pricing selection.
- Retains the draft only in memory in the current session; no local storage, business writes or automatic signing.
- A transient context error still hides all inventory and prices. Once fresh authorization and records succeed, the draft is restored against fresh unit prices and schemes.
- HTTP 401/403, confirmed loss of inventory scope, project switching and actor changes discard the draft. The pilot workspace is keyed by actor identity, and inventory-level denials also clear the selected quote and reference rate.
- The read hook preserves HTTP error status for this decision; it does not retain failed record responses.

## Validation

72 frontend tests across 15 files passed. New regression cases cover context 503 recovery with retained TJS input/term and a changed server price, context 403 clearing, inventory-route 403 clearing, and remount on actor change. Existing project-switch, stale-response and pricing tests still pass.

Changed JSX/hook lint and pilot frontend production build passed. Existing large-chunk build warning remains.

## Source and rollout

Frontend commit f7701c3635d8f9ce07d8c379acf624161078287c on feature/company-projects-foundation. Render static test deploy dep-dbrmsp8u01pc73e0h4cg verified live. Auto-deploy remains off. Backend was not redeployed and no SQL migration was required.

## Browser check

Existing signed-in Plaza test employee entered the illustrative reference rate 10 TJS/USD, deposit 100000 TJS and term 36 months on demo apartment 101. Manual inventory refresh retained the quote (36000 USD total, 10000 USD down, 26000 USD remaining, 722.23 USD/month). Navigating to Warehouses and back restored the selected card and the three input values. The same values were observed again after more than 66 seconds. Transient 503 and real access-denial recovery were simulated in regression tests, not by disrupting the live service. Screenshot: qa/company-project-pricing-recovery.png.

## Remaining scope

This does not persist input across a full browser reload/logout, and does not promise restoration after a real access denial. Active discount schemes are still absent from the demonstration test complex. Real Plaza data, production launch, media/showroom and offer-document generation remain separate work.
