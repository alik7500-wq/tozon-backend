# TOZON Finance Bot

Bot: https://t.me/TozonFinanceBot

The reporting bot reads a consistent CRM snapshot and provides sales, external receipts,
total expenses, and cash desk opening/movement/closing balances. Currencies stay separate;
internal transfers and conversions affect desk balances but do not inflate external totals.
Voided/cancelled/reversed documents and non-cash barter are excluded. Bank receipts appear
in company movement, but not cash on hand. Historical date reports reflect currently active
documents, not immutable accounting closings. Sale dates use signed_at with deal_date as the
legacy fallback. Cash figures use the CRM's posted ledger currency, not an invented current FX rate.

## Activation

- Render environment: `TELEGRAM_FINANCE_BOT_TOKEN` (already configured by owner).
- Existing `SUPABASE_SERVICE_ROLE_KEY` is required for server-only reporting.
- Apply `supabase/migrations/20261011191647_telegram_finance_reports.sql` before deploying.
  Applied and verified on the TOZON project during this implementation.
- Backend automatically registers the authenticated Telegram webhook and commands.
  Default webhook: `https://tozon-backend.onrender.com/api/telegram-finance/webhook`.
  An existing conflicting webhook is never replaced automatically.
- CRM: Settings → Telegram reports. Each of the four recipients presses Start, then an
  administrator/director verifies their Telegram ID and assigns their fixed slot.
- Slots: AKMALKHON (expense details), ILHOM, ASRORKHON, MUBINCHON (summary only).
  The Telegram name never grants permissions. There can be only one account per slot.
- A revoked account loses report access immediately. No recipient is pre-approved.

## Scheduling and operations

- In-process scheduler checks 22:00–23:59 Asia/Dushanbe, with one delivery per recipient/day.
- GitHub daily backup at 17:00 UTC calls the protected `/api/telegram-finance/run` endpoint
  using the existing `SMS_SCHEDULER_INTERNAL_TOKEN` GitHub secret and Render variable.
  GitHub schedules can run late; for a strict 22:00 SLA keep Render continuously available.
- Database worker lease coordinates replicas; webhook updates and delivery claims survive restarts.
- Telegram network timeouts are marked UNKNOWN and never automatically resent.
  PROCESSING after a crash also requires review. A recipient may request /today again.
- Delivery history is visible in the settings panel. SENT means accepted by Telegram, not read.
- Commands: /today, /yesterday, /month, /report YYYY-MM-DD [YYYY-MM-DD], /help.
- Four new tables have RLS enabled and no anon/authenticated/PUBLIC grants.
  Both RPCs are SECURITY INVOKER with fixed search_path and service_role-only execution.
- Token-bearing URLs are never logged; authorization, cookies and webhook secrets are redacted.

## Validation

- Backend: 24 feature tests passed, including isolated PostgreSQL/PGlite migration tests,
  1,005-row snapshot coverage, access denial, webhook authentication, unique slots,
  replica leases, transfers/barter/voided documents and ambiguous delivery handling.
- Frontend: 2 settings tests passed; production build passed.
- Existing isolated cash source-of-truth tests: 10 passed.
- Three existing integration suites were blocked by their production-database guard;
  they were not retried against production and no existing financial documents were changed.
- Live snapshot read: 262 payments, 370 expenses, 51 deals; report calculation succeeded
  without unmapped cash desks. New table grants and RPC execution restrictions verified.
- Supabase advisors: only expected INFO notices for the new private RLS tables without
  client policies. Pre-existing findings in other modules are outside this change.

## Rollback

Disable the bot by removing `TELEGRAM_FINANCE_BOT_TOKEN` and redeploying the previous
backend/frontend commits. Revoke recipients before disabling if reports must stop immediately.
Retain the additive bot tables for audit/recovery; no financial migration rollback is needed.
