import { createHash } from 'node:crypto';
import { createInstagramInboxClient, InboxError } from './instagram-inbox.client.js';
import { getAllInstagramInboxCredentials } from './instagram-connection.repository.js';
import { liveInboxEnabled, readInstagramThreads, readInstagramHistory, saveInstagramThread, blockInstagramReply } from './instagram-live.repository.js';

// Coalesce refreshes across tabs/users. Contents remain durable in the database.
const pending = new Map(), checkedAt = new Map(), failures = new Map();
const identity = c => createHash('sha256').update(c.accountId + ':' + c.token).digest('hex');
function revalidate(key, work, interval = 15000) {
  if (pending.has(key)) return pending.get(key);
  if (Date.now() - (checkedAt.get(key) || 0) < interval) return Promise.resolve();
  checkedAt.set(key, Date.now());
  const promise = work().then(value => { failures.delete(key); return value; }, error => {
    if (['INSTAGRAM_RECONNECT_REQUIRED', 'INSTAGRAM_PERMISSION_REQUIRED', 'INSTAGRAM_ACCOUNT_MISMATCH'].includes(error.code)) failures.set(key, error);
    throw error;
  });
  pending.set(key, promise);
  const clear = () => { if (pending.get(key) === promise) pending.delete(key); };
  promise.then(clear, clear);
  while (checkedAt.size > 1024) checkedAt.delete(checkedAt.keys().next().value);
  return promise;
}
const background = promise => promise.catch(error => console.warn('[instagram-sync]', error instanceof InboxError ? error.code : 'STORAGE_OR_SYNC_FAILED'));
export function createInstagramLiveInbox(credentials) {
  const client = createInstagramInboxClient(credentials), scope = identity(credentials);
  const assertAccess = () => {
    for (const [key, error] of failures) if (key.startsWith(scope + ':')) throw error;
  };
  async function syncHistory(thread, after) {
    const result = await client.messages(thread.contactId, after);
    // Older Graph pages are merged durably but must not replace the latest preview/cursor.
    if (after) {
      await saveInstagramThread(credentials.accountId, { contactId: thread.contactId }, result.data, undefined);
      return result;
    }
    await saveInstagramThread(credentials.accountId, thread, result.data, result.nextCursor, true);
    return result;
  }
  async function syncList() {
    const result = await client.conversations();
    const previous = await readInstagramThreads(credentials.accountId);
    const changed = [];
    for (const thread of result.data) {
      const old = previous.find(t => t.contactId === thread.contactId);
      await saveInstagramThread(credentials.accountId, { ...thread, graphUpdatedAt: thread.updatedAt });
      if (!old?.historySyncedAt || old.graphUpdatedAt !== thread.updatedAt) {
        changed.push(thread);
      }
    }
    // Warm histories independently, with at most two Meta reads at a time. Never hold
    // the conversation-list response behind every customer's history.
    const hydrate = async () => {
      while (changed.length) {
        const thread = changed.shift();
        await background(revalidate(scope + ':history:' + thread.contactId, () => syncHistory(thread), 10000));
      }
    };
    void hydrate(); void hydrate();
    return result;
  }
  return {
    async conversations(after) {
      if (after) return client.conversations(after);
      const stored = await readInstagramThreads(credentials.accountId);
      const refresh = revalidate(scope + ':list', syncList);
      if (!stored.length) await refresh;
      else background(refresh);
      assertAccess();
      return { data: stored.length ? stored : await readInstagramThreads(credentials.accountId), nextCursor: null, autoRefresh: true };
    },
    async messages(contact, after) {
      assertAccess();
      if (after) return syncHistory({ contactId: contact }, after);
      const stored = await readInstagramHistory(credentials.accountId, contact);
      const refresh = revalidate(scope + ':history:' + contact, () => syncHistory({ contactId: contact }), 15000);
      if (!stored?.syncedAt) await refresh;
      else background(refresh);
      const result = stored?.syncedAt ? stored : await readInstagramHistory(credentials.accountId, contact);
      return { data: result?.data || [], nextCursor: result?.nextCursor || null, autoRefresh: true,
        replyBlocked: !!result?.replyBlockedUntil && Date.parse(result.replyBlockedUntil) > Date.now() };
    },
    async send(contact, text) {
      const stored = await readInstagramHistory(credentials.accountId, contact);
      if (stored?.replyBlockedUntil && Date.parse(stored.replyBlockedUntil) > Date.now()) throw new InboxError('INSTAGRAM_REPLY_WINDOW_CLOSED', 409);
      let result;
      try { result = await client.send(contact, text, stored?.lastInboundAt); }
      catch (error) {
        if (error.code === 'INSTAGRAM_REPLY_WINDOW_CLOSED') await blockInstagramReply(credentials.accountId, contact);
        throw error;
      }
      const message = { message_id: result.messageId, text_content: text.trim(), created_at: new Date().toISOString(),
        is_echo: true, attachments: [], shares: [], reactions: [], contentUnavailable: false };
      // Meta already accepted: a persistence failure must never encourage sending twice.
      try { await saveInstagramThread(credentials.accountId, { contactId: contact, lastMessage: message.text_content, updatedAt: message.created_at }, [message]); }
      catch { return { ...result, message, saved: false }; }
      return { ...result, message, saved: true };
    },
    sync: () => revalidate(scope + ':list', syncList)
  };
}
export function startInstagramInboxSync() {
  if (!liveInboxEnabled()) return;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const accounts = await getAllInstagramInboxCredentials();
      // An inaccessible account must not stop synchronization for the others.
      let index = 0;
      const worker = async () => {
        while (index < accounts.length) {
          const credentials = accounts[index++];
          try { await createInstagramLiveInbox(credentials).sync(); }
          catch (error) { console.warn('[instagram-sync]', error instanceof InboxError ? error.code : 'SYNC_FAILED'); }
        }
      };
      await Promise.all([worker(), worker()]);
    } catch (error) { console.warn('[instagram-sync]', error instanceof InboxError ? error.code : 'SYNC_FAILED'); }
    finally { busy = false; }
  };
  void tick();
  const timer = setInterval(tick, 15000); timer.unref();
  return () => clearInterval(timer);
}
