# Instagram Direct rollout checklist

This integration is NOT production-ready and must remain disabled.

## Current gates
- [ ] Frontend PR #71: production build passes and response parsing verified.
- [ ] Backend PR #37: all tests pass on latest commit.
- [ ] Queue: recover stale `processing` events using a bounded lease and fencing token; implement retry delay and dead-letter handling.
- [ ] Access: map every Instagram account to the authenticated tenant; deny cross-tenant reads in both conversation routes. Do not rely on client-supplied account IDs.
- [ ] Validate webhook signature, raw body ordering, payload size and replay safety.
- [ ] Test duplicate deliveries, failed DB writes, worker crash/restart and concurrent workers.
- [ ] Test real Instagram account only after Meta permissions and webhook subscription are confirmed.
- [ ] Confirm logs redact access tokens and message bodies.
- [ ] Confirm opt-in worker environment flag remains unset until explicit go-live approval.

## Manual smoke test after safeguards
1. Connect the intended Instagram account via OAuth.
2. Send a test Direct message from a separate Instagram user.
3. Confirm one signed webhook event is stored and eventually marked processed.
4. Confirm exactly one normalized message appears in the correct tenant's inbox.
5. Confirm another tenant cannot read the conversation.
6. Repeat delivery and verify no duplicate message.
7. Restart worker mid-processing; verify safe recovery.
8. Verify UI displays conversation and read-only state.

Never merge these draft PRs or enable the worker solely because tests are green.
