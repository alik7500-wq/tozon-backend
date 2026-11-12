const GRAPH = 'https://graph.facebook.com/v25.0';
export class InboxError extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,512}$/.test(value);
export function inboxCursor(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_=-]{1,2048}$/.test(value)) throw new InboxError('INVALID_CURSOR', 400);
  return value;
}
// Use only fixed-host requests and caller-supplied cursors, never Meta paging URLs.
export function createInstagramInboxClient({ accountId, token, request = fetch, now = Date.now }) {
  async function graph(path, params = {}, body) {
    const url = new URL(GRAPH + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    let response, result;
    try {
      response = await request(url, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        signal: AbortSignal.timeout(15000), ...(body ? { body: JSON.stringify(body) } : {}) });
      result = await response.json();
    } catch { throw new InboxError(body ? 'INSTAGRAM_SEND_UNCONFIRMED' : 'INSTAGRAM_UNAVAILABLE', 503); }
    if (!response.ok || result?.error) {
      const code = result?.error?.code;
      throw new InboxError(code === 190 ? 'INSTAGRAM_RECONNECT_REQUIRED' : [10, 200].includes(code)
        ? 'INSTAGRAM_PERMISSION_REQUIRED' : [4, 17, 32, 613].includes(code)
          ? 'INSTAGRAM_RATE_LIMIT' : 'INSTAGRAM_REQUEST_FAILED', code === 190 ? 409 : 502);
    }
    if (!result || typeof result !== 'object') throw new InboxError('INSTAGRAM_INVALID_RESPONSE');
    return result;
  }
  let ownPage;
  async function page() {
    if (!ownPage) {
      const p = await graph('/me', { fields: 'id,instagram_business_account' });
      if (!/^\d+$/.test(p.id || '') || String(p.instagram_business_account?.id) !== accountId) {
        throw new InboxError('INSTAGRAM_ACCOUNT_MISMATCH', 409);
      }
      ownPage = p.id;
    }
    return ownPage;
  }
  function next(body) {
    return body.paging?.next && typeof body.paging?.cursors?.after === 'string'
      ? inboxCursor(body.paging.cursors.after) : null;
  }
  function contactOf(c, pageId) {
    const contacts = c.participants?.data?.filter(p => /^\d+$/.test(p.id || '') && ![accountId, pageId].includes(p.id)) || [];
    return contacts.length === 1 ? contacts[0] : null;
  }
  async function conversations(after) {
    const pageId = await page();
    const body = await graph(`/${pageId}/conversations`, { platform: 'instagram', limit: 50,
      fields: 'id,participants,updated_time,messages.limit(1){message,created_time}', after: inboxCursor(after) });
    if (!Array.isArray(body.data)) throw new InboxError('INSTAGRAM_INVALID_RESPONSE');
    return { data: body.data.flatMap(c => {
      const contact = contactOf(c, pageId);
      if (!contact || !validId(c.id)) return [];
      return [{ instagramAccountId: accountId, contactId: contact.id, name: contact.username || contact.name || null,
        lastMessage: c.messages?.data?.[0]?.message || '', updatedAt: c.updated_time || null }];
    }), nextCursor: next(body) };
  }
  async function conversation(contactId) {
    if (!/^\d{1,40}$/.test(contactId || '')) throw new InboxError('INVALID_CONTACT', 400);
    const pageId = await page();
    const body = await graph(`/${pageId}/conversations`, { platform: 'instagram', user_id: contactId,
      fields: 'id,participants', limit: 2 });
    const matching = body.data?.filter(c => contactOf(c, pageId)?.id === contactId && validId(c.id));
    if (matching?.length !== 1) throw new InboxError('INSTAGRAM_CONVERSATION_NOT_FOUND', 404);
    return matching[0].id;
  }
  async function readMessages(conversationId, after) {
    const body = await graph(`/${encodeURIComponent(conversationId)}/messages`, {
      fields: 'id,created_time,from,to,message,attachments', limit: 50, after: inboxCursor(after) });
    if (!Array.isArray(body.data)) throw new InboxError('INSTAGRAM_INVALID_RESPONSE');
    const pageId = await page();
    return { data: body.data.map(m => ({ message_id: m.id, text_content: m.message || '',
      has_attachments: Boolean(m.attachments?.data?.length), created_at: m.created_time,
      senderId: m.from?.id, is_echo: [accountId, pageId].includes(m.from?.id) })), nextCursor: next(body) };
  }
  async function messages(contactId, after) {
    const c = await conversation(contactId);
    const result = await readMessages(c, after);
    return { ...result, data: result.data.map(({ senderId: _senderId, ...m }) => m)
      .sort((a,b) => Date.parse(a.created_at) - Date.parse(b.created_at)) };
  }
  async function send(contactId, text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new InboxError('INVALID_MESSAGE', 400);
    const c = await conversation(contactId);
    let after, eligible = false;
    // Fail closed if the inbound message cannot be verified in the bounded history.
    for (let i = 0; i < 5; i++) {
      const result = await readMessages(c, after);
      eligible = result.data.some(m => m.senderId === contactId && !m.is_echo &&
        Date.parse(m.created_at) <= now() && now() - Date.parse(m.created_at) < 24 * 60 * 60 * 1000);
      if (eligible || !result.nextCursor) break;
      after = result.nextCursor;
    }
    if (!eligible) throw new InboxError('INSTAGRAM_REPLY_WINDOW_CLOSED', 409);
    // No automatic retries: a timeout may still mean Meta accepted the message.
    const result = await graph(`/${await page()}/messages`, {}, {
      recipient: { id: contactId }, message: { text: text.trim() }, messaging_type: 'RESPONSE' });
    if (!result.message_id) throw new InboxError('INSTAGRAM_SEND_UNCONFIRMED', 503);
    return { messageId: result.message_id };
  }
  return { conversations, messages, send };
}
