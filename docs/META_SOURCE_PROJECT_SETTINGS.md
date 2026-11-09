# Meta source settings and project bindings

Administrators can authorize a Meta identity, discover the assets actually granted
to that identity, and assign each Instagram channel, Facebook Page channel or
Facebook lead form to one active CRM project. Sources start unassigned. A form is
identified by its Meta form ID, so forms from the same Page can use different projects.

## Release scope

This change implements **configuration**, not delivery of leads or an inbox worker.
It does not subscribe Pages to webhooks, retrieve individual lead submissions,
create CRM leads, process comments, or send replies. Existing Instagram routes and
their explicit rollout flags remain separate. This change does not repair or
verify the previously observed Meta client-secret rejection.

Do not advertise messaging or lead intake as live on the strength of a saved
binding. The next release needs signed webhook intake, stable event deduplication,
project-scoped lead/inbox materialization and employee authorization, followed by
a real message/form test for each enabled channel. These are not implemented here.

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

The migration in supabase/migrations/20261109184102_meta_source_project_routing.sql
was tested locally using PGlite and has not been applied to a hosted database.
Apply it through the deployment's Postgres migration process, not the legacy
SQLite-based npm migrate script. Deploy the paired frontend change afterward.

Existing settings: META_INSTAGRAM_APP_ID, META_INSTAGRAM_APP_SECRET,
SOCIAL_TOKEN_ENCRYPTION_KEY, SUPABASE_SERVICE_ROLE_KEY.

New settings:

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

## Verification

Automated checks cover actual PostgreSQL transactions/constraints, role grants,
ownership conflicts, archived/unknown projects, token expiry, reconnect/disconnect,
OAuth state, cancelled callbacks, asset discovery/pagination, API authorization,
and UI saves/errors. The existing Instagram tests are included as regressions.
The stale legacy config-ID expectation was corrected to the configuration already
used by main; the legacy authorization implementation itself was not changed.

UI component tests use fixtures; they are not evidence of a real Meta connection.
No production data, secrets or Meta settings were changed by this implementation.
