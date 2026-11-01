# Lead intake: files and future Google Forms

Open CRM → Leads → **Импорт / Google Форма** as ADMIN or DIRECTOR with access to leads.

## Files

- `.xlsx` or UTF-8 `.csv`; up to 2 MiB, 500 records and 60 columns per sheet.
- First nonempty row contains headers. Download the empty template in the modal.
- Choose a sheet and map name, phone, optional note and source timestamp.
- Set source, campaign/webinar name, optional project and active sales representative.
- Preview is read-only. Commit processes 25 rows per request and shows each outcome.
- Preview signatures are bound to the actor and exact contents, and expire in 30 minutes.
- Local nine-digit numbers are interpreted as Tajikistan (+992). International numbers require a country code. Matching also checks secondary phone numbers.
- First valid occurrence of a phone within a file is considered; later occurrences are skipped.
- Existing contact/name, owner, stage and project are never overwritten. Repeat inquiries append a note. Archived or ambiguous matches are skipped for human review.
- Identical normalized content + settings are idempotent even after reopening or reuploading the file. A different campaign counts as a new inquiry.
- An assigned lead gets an open CALL task; an existing open CALL task is preserved. Pool leads receive tasks through the normal assignment workflow later.
- Excel formulas must be replaced with values before upload. No data is written during file parsing or preview.

## Google Forms

No Google account or sheet is connected automatically. A new per-source key and configuration can be prepared before a webinar exists.

1. Create a Google Form connection in the modal. Save its one-time key in a password manager; only its SHA-256 hash is stored in CRM. Download the `.gs` source for that connection.
2. Create a Google Form and link its responses to a Google Sheet. Select the response sheet.
3. Open Extensions → Apps Script, insert the downloaded script.
4. Project Settings → Script Properties: set `TOZON_KEY` to the key. If needed, set `NAME_COLUMN`, `PHONE_COLUMN`, and `NOTES_COLUMN` to exact response headers.
5. Run `installTozon` once and grant Google permissions. It installs spreadsheet form-submit and five-minute retry triggers under the Google account running it.
6. Submit one test response and check the sheet's `TOZON статус` plus CRM's recent submissions.

Only rows added after installation are picked up automatically. Import previous responses separately via a file. Reinstalling on the same sheet preserves the original start row. Do not sort, delete or move pending responses above that start row.

The script stores an immutable response UUID in `TOZON ID`. A network failure can be retried with that same UUID, including if CRM accepted the request before the response was lost. `OK` rows are skipped. `ERROR` indicates invalid data, an archived contact or ambiguous match; review and clear the status cell after correction. `RETRY` rows are retried automatically. HTTP 401 requires checking the key/connection; HTTP 429 pauses the current run. Each run attempts at most 25 responses for up to 45 seconds; quotas and failures can delay delivery. Header/configuration errors are visible in Apps Script executions.

Disabling a connection rejects further requests. Rotating a key immediately invalidates the old key; update `TOZON_KEY` in the sheet. Keys never appear in the downloadable script or persistent browser storage. Do not share them with form respondents.

## Backend

- `/api/leads/intake/file`, `/preview`, `/commit`, `/options`, `/integrations`: authenticated leadership only.
- `/api/leads/intake/google/:id`: source key in `x-lead-intake-key`, no CRM login required. Configuration, source and manager are resolved server-side, not from form input.
- `crm_intake_lead` is service-role-only, SECURITY INVOKER. Row-level transaction + advisory locks atomically persist lead/note, inquiry and task. It does not change any financial record.
- New tables have RLS enabled and no anon/authenticated access; secrets are hashed. Logging redacts the integration key and response cookies.
- This change adds file source labels for Instagram/WhatsApp; it does not implement their direct platform adapters.

References: https://developers.google.com/apps-script/guides/triggers/events ; https://developers.google.com/apps-script/reference/script/spreadsheet-trigger-builder ; https://developers.google.com/apps-script/reference/properties/properties-service ; https://supabase.com/docs/guides/database/functions
