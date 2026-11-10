# Meta source settings and project bindings

Administrators can authorize a Meta identity, discover the assets actually granted
to that identity, and assign each Instagram channel, Facebook Page channel or
Facebook lead form to one active CRM project. Sources start unassigned. A form is
identified by its Meta form ID, so forms from the same Page can use different projects.

## Release scope

This release implements configuration, signed webhook intake, a durable event
journal, Facebook form delivery subscription/verification and a leased form worker.
Messages/comments are stored as inquiries, not invented phone contacts. A Facebook
form containing a real phone can create a lead or append a repeat-inquiry note
within the captured project. Existing name, stage and manager are preserved.
Matching phones in another project are never merged. Ambiguous/archived matches
and missing/invalid phones require review. New form leads enter the unassigned pool.

The event journal is limited to the owning administrator. This is not a replacement
for a full conversation inbox and does not send replies. No outbound messages or
Meta test leads were sent during implementation. Incoming Instagram messages and
comments still require appropriate Meta dashboard/account subscriptions. The new
subscription action handles Facebook Page leadgen only and preserves fields already
subscribed by this app; POST success is followed by a verification GET.

The previously observed client-secret rejection has not been verified as resolved.
A new administrator-only preflight action tests app credentials on the server and
returns fixed diagnostic categories, never the app token or raw Meta error text.
Successful preflight does not mean Instagram is connected or delivering events.

## Installation and authorization model

Target: one company per isolated database/API installation. There is no tenant ID
in these new tables; this is not suitable for a shared multi-company database.
Within an installation, settings belong to the initiating CRM administrator.
Another administrator cannot adopt or overwrite that administrator's sources.
Managers, finance users and warehouse users cannot access these settings. Matrix
administrators additionally need automation.view and automation.manage.

All new tables have RLS enabled and no anon/authenticated/PUBLIC privileges.
Only server service_role operations are granted. Tokens use existing AES-256-GCM
encryption and are excluded from response projections. Sync, disconnect and bind
operations are invoker RPC transactions. Disconnect clears stored tokens and
bindings and cancels pending OAuth completions. Loss of an asset grant clears
its Page token and makes it unavailable. Switching Meta identities clears bindings.
Reconnect preserves project choices for assets still granted to the same identity.

## Deployment prerequisites

Both migrations (20261109184102_meta_source_project_routing.sql and
20261110070826_meta_source_event_intake.sql) were tested locally using PGlite
and have not been applied to a hosted database. Apply them in that order.
Apply them through the deployment's Postgres migration process, not the legacy
SQLite-based npm migrate script. Deploy the paired frontend change afterward.

Existing settings: META_INSTAGRAM_APP_ID, META_INSTAGRAM_APP_SECRET,
SOCIAL_TOKEN_ENCRYPTION_KEY, SUPABASE_SERVICE_ROLE_KEY.

New settings (all runtime flags default to off):

- META_SOURCE_INGEST_ENABLED=true enables signed intake only after callbacks are
  configured. Endpoint: /api/integrations/meta/webhook for GET challenge and POST.
- META_SOURCES_WEBHOOK_VERIFY_TOKEN is a separate private verification string for
  that endpoint; it is not the App Secret. Register the callback and relevant
  fields for page / instagram in the intended Meta application.
- META_FORM_LEADS_ENABLED=true starts the in-process worker. Keep this OFF until
  project-level visibility and assignment rules are verified in the target CRM.
  The existing core lead APIs do not enforce new object membership rules merely
  because interested_project_id is filled. In a shared multi-object installation,
  enabling automatic creation before that verification can expose a new pooled
  lead to the wrong staff. The administrator-only event journal remains private.

- META_SOURCE_ROUTING_ENABLED=true only after schema/configuration verification.
- META_SOURCES_REDIRECT_URI=https://<API host>/api/integrations/meta/callback;
  register that exact URL in Meta before use. The legacy redirect is unchanged.
- META_SOURCES_CONFIG_ID: a Facebook Login for Business configuration for this
  same application. This feature does not hardcode or replace the legacy config ID.

The catalogue uses the existing Graph v25.0 baseline. It inspects the token's
application, validity, granted scopes and both expiry deadlines. It does not extend
system-user tokens as if they were short-lived user tokens. Expired access requires
reconnection. Page/form pagination stays on the fixed Graph host and fails closed
on incomplete or invalid paging. Source visibility also depends on granular asset
grants and the user's Page/form access; OAuth success alone is insufficient.

Available categories are Instagram messages/comments, Facebook messages/comments,
and active Facebook forms. Their respective scopes must actually be present in
the token inspection; the code does not assume requesting a scope grants it.
Meta permissions, App Review and configuration still require a live verification.

## Event processing and operations

Raw JSON bytes are checked with X-Hub-Signature-256 before parsing. The webhook
acknowledges only after a transaction stores normalized events. Only known,
available sources from active owner connections are accepted. Each event key is
stable across batches and retries; raw external URLs/attachments are not stored.
Unknown sources and delivery/read/echo notifications do not become inquiries.

Project routing is captured when the event arrives. Remapping a source affects
future deliveries. Historical unassigned events require an explicit owner action
using the current source binding. The browser supplies an expected project only
to detect concurrent remapping; it cannot choose a different destination. Paused,
failed and review events can be explicitly retried only without changing an
already captured project.
Disconnect clears all tokens, bindings and pending authorizations and pauses queued
work. Existing historical events remain assigned to their original projects.

The form worker claims at most 5 jobs with SKIP LOCKED and 2-minute leases. Expired
leases can be reclaimed; a stale worker cannot commit. Failures use bounded retry
and fixed codes. Contact creation/note insertion and completion are one transaction.
A crash after completion cannot create a duplicate lead. The worker does not request
lead data on the webhook delivery path and requires no new Render service.

This implementation has not deployed or enabled any hosted runtime flags, changed
Meta subscriptions, generated test leads, or changed existing customer records.
A live OAuth, leadgen subscription and per-project message/form test remain release
gates. Browser visual QA was unavailable because local Chromium could not start;
component tests and the build are not substitutes for a live Meta test.

## Verification

Automated checks cover actual PostgreSQL transactions/constraints, role grants,
ownership conflicts, archived/unknown projects, token expiry, reconnect/disconnect,
OAuth state, cancelled callbacks, asset discovery/pagination, API authorization,
and UI saves/errors. The existing Instagram tests are included as regressions.
The stale legacy config-ID expectation was corrected to the configuration already
used by main; the legacy authorization implementation itself was not changed.

UI component tests use fixtures; they are not evidence of a real Meta connection.
No production data, secrets or Meta settings were changed by this implementation.
