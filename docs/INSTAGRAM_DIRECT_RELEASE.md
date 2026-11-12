# Instagram Direct — read and reply release

The connected TOZON account previously showed an inbox error because the frontend called routes absent from the backend and the section matrix denied them. This change adds authenticated conversation/history reads against Meta Graph v25.0 with the saved encrypted Page token, plus a text reply endpoint used only on explicit user submission.

## Access and data

- Existing isolated TOZON installation and account 17841447499018452 only; no shared SaaS tenant model is introduced.
- ADMIN/DIRECTOR only; matrix accounts need leads.view for reads and leads.view + leads.manage for sending. Existing finance restrictions remain intact.
- Token decrypted only in the backend; verify Page identity and linked Instagram on every request. Foreign account/contact paths are rejected.
- Graph cursors only; no paging URL forwarding. Dialogs and messages expose a fixed projection without tokens/raw API errors or attachment URLs.
- No schema changes, credential changes, automatic messages, webhook activation or lead creation.
- No automatic send retries. Replies require a customer message less than 24 hours old, verified from at most 250 recent messages. Older/unverifiable history fails closed. Graph remains the message source of truth.
- Refresh is manual; historical pages can be loaded explicitly. Attachments are represented by a label in this release.

## Verification

- Backend: 82 related tests passed (OAuth, inbox adapters/routes, real section access, signed ingestion regression).
- Frontend: 4 tests passed (failed vs empty inbox, contact switching race, cursor pagination); production build passed.
- Live read-only adapter probe on the existing connection: identity 200, conversations 200 (6 dialogs), selected history 200 (1 message). No messages were sent.
- End-to-end reply sending requires an explicitly approved test recipient/text and a current customer-initiated conversation. It has not been exercised with a real customer.
