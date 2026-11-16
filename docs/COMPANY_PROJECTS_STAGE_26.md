# Stage 26 — Confirmed app-update notices

## Delivery and scope

Frontend runtime `c93886586a3a445e99c6e7fd70f17339182ed78b`, branch `feature/company-projects-foundation`. Only the isolated test static frontend is redeployed. The backend, database, employee grants, financial records, production and main branches are unchanged.
Test static deploy `dep-dbtlpjoae00c73eac7c0` reached `live` on this commit. Automatic deployments remain off.

## Evidence and fix

During earlier browser checks, the update banner sometimes remained visible after reloading the app. Inspection identified a concrete lifecycle problem: once shown, the old notice was never removed when a later manifest check returned the already loaded build. Another issue was that, if a second release arrived while a notice was visible, Later still dismissed the first release ID.

The public pre-change probe returned matching shell/manifest ID `7eaadfacaae6d5e2f76b2cf689db888d` and Cache-Control `public, max-age=0, s-maxage=300`. The browser DOM matched that ID and had no banner in that stable probe. CDN caching therefore remains a relevant release-transition risk; this stage does not claim that a false banner was reproduced in that particular stable session or that cache policy was changed.

The app now confirms a changed manifest ID against the public `/index.html` build metadata before offering an update. Both requests are same-origin, credential-free, no-store, redirect-rejecting and share the existing 10-second abort budget. Invalid/oversized/duplicate shell metadata is ignored; fetched HTML is inspected as bounded text and never mounted or executed. No API, session, cookie or financial data are requested by the updater.

If the manifest or confirmed shell identifies the loaded build, or valid shell and manifest disagree, an updater-owned obsolete notice is removed. A newer confirmed candidate updates the existing notice's tracked ID without replacing its DOM or stealing focus; Later dismisses that latest candidate. Independent startup/module-failure alerts are not removed or replaced. Shutdown aborts the pending check and removes only the updater's own notice. A late response after timeout cannot display a banner.

The update link recomputes its URL on click, retaining the current route/query rather than the route at the time the banner first appeared. There is no automatic navigation, reload, React-state update, project switch or draft modification. An explicit user-requested reload still requires saving the draft first; this stage does not promise persistence of unsaved forms across that reload.

## Validation

- Focused update/build-version tests: **12 passed**.
- Selected workspace, pricing, update and build-version suites: **106 tests / 19 files passed**.
- Changed-file oxlint, flagged production build and git diff --check passed; existing large-chunk build warning remains.
- Regression coverage includes inconsistent edge responses, removal when the current build is confirmed, two successive releases with Later, preserving focused controls/draft/project selection, fresh click route, malformed/oversized/duplicate metadata, independent module-failure alerts, late timeout responses, offline/hidden tabs, cancellation and unchanged service-worker registration/navigation behavior.
- Post-live public HTTP verification checked root HTML, index.html, crm-version.json and the module entry referenced by the served HTML. Both HTML identifiers match manifest build `dae973f3191edf691858ea6a1042d025`, differ from the prior build, and the served entry includes the new confirmation/notice-ID code. [Public verification record](qa/company-project-updates-public.json). This is delivery evidence, not a substitute for live-form/browser behavioral verification.

## Verification limits and remaining cache work

The browser attempt to open the Render dashboard was interrupted, after which the Browser connector reported that its originating context was unavailable. No Render header mutation was made, and no alternate channel was used to bypass that interrupted dashboard action. New live-form/browser behavior could not be verified in this stage; preservation is covered by deterministic DOM tests, not claimed as a completed browser check. No new browser screenshot is supplied.

The two-file confirmation reduces inconsistent-edge false alerts and removes resolved notices; it cannot prove freshness when both public CDN files agree on the same stale release. The observed five-minute shared-cache policy remains unchanged. A future cache-header change and a repeat release/draft test in the connected browser remain outstanding. No blanket claim of production readiness or fully resolved CDN behavior is made.
