# Instagram Direct: durable history and automatic intake

The previous API fetched Meta on every cold history read (observed 4–8 seconds).
The live inbox instead reads installation-local PostgreSQL history while a
coalesced background synchronizer checks Meta every 15 seconds. Signed Instagram
webhooks write the same durable history immediately. The UI checks CRM every
3 seconds while visible; the Leads page checks every 5 seconds. Hidden tabs pause.

## Rollout

- Apply `20261112120738_instagram_live_inbox.sql` before enabling the feature.
- Backend flags: `INSTAGRAM_LIVE_INBOX_ENABLED=true`,
  `INSTAGRAM_WEBHOOK_INGEST_ENABLED=true`,
  `INSTAGRAM_INBOX_ACCOUNT_ID=17841447499018452`.
- The existing Instagram app subscription points to
  `/api/integrations/instagram/webhook`. Subscribe the Instagram account's
  `subscribed_apps` edge to `messages` with the existing Page token. The Instagram
  edge accepts this token; the Page edge separately requires pages_manage_metadata.
- No automatic sending, scope expansion, or historical lead backfill.

## Data and access

All new tables have RLS and no anon/authenticated privileges. RPC is SECURITY
INVOKER, executable only by service_role. Existing backend authentication, active
user checks, ADMIN/DIRECTOR restriction and leads.view/manage matrix remain.
Each durable row is keyed by connected Instagram account and contact. The atomic
RPC serializes a thread, deduplicates message IDs and creates one NEW/INSTAGRAM
lead on inbound messages after rollout activation. Phone is empty, never invented.
The stable account/contact identifiers are included in the lead note. Existing
leads are not guessed/merged by display name. Old history and outgoing echoes do
not create leads. No external notifications or SMS are sent.

Webhook HMAC and account checks remain fail-closed. A storage/processing failure
returns 503 so Meta retries; message/lead writes are idempotent. Graph omissions
do not overwrite useful webhook text; explicit message deletion does.

## Sending

A recent inbound timestamp comes only from private verified history; client
timestamps are never accepted. Verify token/Page identity, then perform one send,
without re-reading the same history. Existing Graph fallback validates cold
conversations and the reply window. Never automatically retry a POST or a timeout.
Show the confirmed outgoing message immediately; history refresh is independent.
Persisted refusal clears only when a newer inbound message arrives.

Meta subcode 2534022 is REPLY_WINDOW_CLOSED (409), not a missing OAuth permission.
2534037 is THREAD_OWNER_REQUIRED. Only numeric codes and operation are logged.
The observed live empty-message diagnostic returned 10/2534022 for the user's
test contact; no actual message was sent. App Dashboard still shows Not published
and requires a privacy-policy URL before publishing. Enabling code cannot bypass
Meta policy, publication, tester-role or App Review requirements. Publication or
granting new app roles is outside this release's automatic operations.

## Verification

PGlite tests cover atomic lead creation, duplicate delivery, history/echo exclusion,
cross-account rejection, rollback, reply blocking, cursor preservation, Unicode,
deletion and browser-role denial. Mocked integration/UI tests cover nonblocking
cached reads, refresh coalescing, immediate confirmed sends, draft preservation,
automatic new conversations/messages and no polling overlap. Actual delivery must
be verified with an authorized live test after resolving Meta's remaining refusal.

Disable the live flag to use the original Graph adapter; leave new private tables
intact. Disabling ingest stops webhooks with 503. Do not delete messages/leads as
part of a code rollback.
