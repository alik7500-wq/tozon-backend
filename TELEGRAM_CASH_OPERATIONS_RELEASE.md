# Telegram cash operations

Recipients can read all historical PKO/RKO documents of their assigned cash desk,
including cancelled documents with their status, paginated ten at a time.
AKMALKHON can select any desk or all desks. Reports and daily cash totals for
other slots are filtered to the assigned desk. Sales statistics remain the existing
project-wide statistics. Unassigned recipients cannot read cash information.

CRM Settings → Telegram reports now assigns a cash desk, an existing active CRM
user as expense author, and a separate expense-entry permission. No person is
automatically granted a new cash assignment or financial writing permission.
The owner's read access continues to cover every desk without assignment.

The bot supports /pko, /rko_list and a guided /rko flow. It collects the desk,
currency, amount, accounting source, optional actual exchange rate, date, category,
recipient and purpose, then presents a review with Confirm/Cancel buttons.
No expense is posted before confirmation. /cancel ends the current flow.
PKO creation, editing, deletion and cancellation are not available through the bot.

Sessions and drafts are stored server-side, survive restarts, and are inaccessible
to anon/authenticated roles. Confirmation locks the draft, checks current recipient
authorization, cash assignment, active CRM author and active desk, and invokes the
existing atomic expense RPC. Draft UUID provides a durable idempotency key.
An insufficient balance rolls back the entire confirmation. A posted draft returns
its original result when confirmed again; revocation also blocks repeated access.

For TJS expenses users can explicitly debit the TJS ledger, or debit USD at their
entered actual rate. The second option records the expense in USD and preserves
the original TJS amount/rate as metadata, matching the CRM ledger convention.
The confirmation shows the same cent rounding as PostgreSQL; it does not create
a hidden incoming PKO or assume an exchange rate. Cash transfers and bank/barter
cash entry are handled separately in CRM.

Migration: supabase/migrations/20261012094220_telegram_cash_operations.sql.
Validation: 34 backend tests, 3 frontend tests, and frontend build passed.
The migration was verified on isolated PGlite PostgreSQL with cross-desk denial,
insufficient-funds rollback, duplicate confirmation, revocation, and private grants.
Production verification is read-only; no test financial documents were created.

Rollback: revert the bot/frontend commits and disable expense-entry permissions.
Retain additive sessions/drafts for audit; do not delete posted financial documents.
