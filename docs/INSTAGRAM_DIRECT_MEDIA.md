# Instagram Direct rich content

Adds a fixed safe projection for Graph message attachments (images/GIFs, video, audio, files), stickers, shared links/publications, story references, and reaction summaries. Ordinary text, Unicode and emoji are preserved. Conversation previews identify the available content type.

The frontend displays images and native video/audio controls, opens files and shared materials in a new tab, and shows a clear fallback for missing/expired content. It never renders provider HTML or embeds arbitrary third-party URLs. Media URLs must be HTTPS on Meta CDN hosts; token-bearing query parameters and executable schemes are rejected on both server and client. Existing account/role checks, Page-token validation and text reply window are unchanged. No new DB schema, token grants, inbound webhook activation or customer messages.

## Limits

This is a renderer for content actually supplied by Graph. Meta can omit content, return unsupported events, omit old reactions, or make story/shared media unavailable. Such messages link to the Instagram inbox and explain that the API did not supply their content; they are not called empty messages. Media links can expire; Refresh requests fresh Graph data. No claim is made that missing historical content is recoverable, or that every possible Instagram interaction can be retrieved.

Official Graph message documentation retrieval was rate-limited (HTTP 429). The existing connected-account read probe confirmed accepted fields for shares/sticker/story/reactions/is_unsupported; is_deleted is rejected and is not requested. Additional fields are tested against live reads before release. Tests cover projection, safe URLs, Unicode, mixed text/media, player controls, expired media fallback, and unavailable content.

Live adapter read result: 6 conversations, 25 messages, 7 shares, 0 attachment objects, 0 reaction objects, 3 unsupported/unavailable messages. Historical content marked unsupported by Meta is not recovered. Image/audio/video/sticker rendering uses controlled fixtures because those media types were absent from the sampled Graph responses.

Validation: 87 related backend tests and 11 frontend tests passed; production build passed.
