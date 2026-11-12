# Instagram Direct loading performance

Observed production history requests before optimization: approximately 4.4–7.5 seconds. Each history request performed Page identity validation, contact-to-conversation lookup and a message read sequentially.

## Changes

- Cache only verified Page/conversation identifiers on the server for 60 seconds, bounded to 1,024 entries. Keys include a SHA-256 digest of the exact token and account ID. Plaintext tokens and message bodies are not stored in this cache. Conversation-list results seed the mapping. A warm history read uses one Graph request rather than three.
- Authorization and connection lookup still run on every HTTP request. Meta checks the Page token on every message read. Graph read failures invalidate the cached mapping. Token rotation uses a different cache namespace. Sending always performs fresh identity/contact checks and the existing reply-window validation.
- Keep up to 20 loaded histories in component memory. Reopening shows them immediately; after 10 seconds they revalidate in the background. Nothing is stored in localStorage/sessionStorage. Concurrent identical reads are deduplicated, manual Refresh and post-send refresh force a read, and stale requests cannot overwrite the active contact. Authorization failures remove displayed cached data.
- The first uncached read remains dependent on Meta response time. No realtime delivery guarantee is introduced.

Validation covers warm call count, TTL expiry, cache bounds, token/account isolation, error invalidation, fresh send checks, immediate cached display, background refresh, in-flight deduplication, contact switching and forced manual refresh.

Local validation: 93 related backend tests and 16 frontend tests passed; production build and diff checks passed.
