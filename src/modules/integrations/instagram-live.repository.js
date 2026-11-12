import { getServiceDB } from '../../db/connection.js';
import { InboxError } from './instagram-inbox.client.js';

const check = result => {
  if (result.error) throw new InboxError('INSTAGRAM_STORAGE_UNAVAILABLE', 503);
  return result.data;
};
export const liveInboxEnabled = () => process.env.INSTAGRAM_LIVE_INBOX_ENABLED === 'true';
export async function saveInstagramThread(accountId, thread, messages = null, nextCursor = null, complete = false) {
  return check(await getServiceDB().rpc('crm_instagram_store_thread', {
    p_account: accountId, p_contact: thread.contactId, p_name: thread.name || null,
    p_preview: thread.lastMessage || null, p_updated: thread.updatedAt || null,
    p_messages: messages, p_cursor: nextCursor, p_complete: complete,
    p_graph_updated: thread.graphUpdatedAt || null
  }));
}
export async function readInstagramThreads(accountId) {
  const rows = check(await getServiceDB().from('crm_instagram_threads')
    .select('contact_id,name,preview,updated_at,lead_id,history_synced_at,graph_updated_at')
    .eq('account_id', accountId).order('updated_at', { ascending: false }).limit(200));
  return rows.map(r => ({ instagramAccountId: accountId, contactId: r.contact_id,
    name: r.name, lastMessage: r.preview, updatedAt: r.updated_at, leadId: r.lead_id,
    historySyncedAt: r.history_synced_at, graphUpdatedAt: r.graph_updated_at }));
}
export async function readInstagramHistory(accountId, contactId) {
  if (!/^\d{1,40}$/.test(contactId || '')) throw new InboxError('INVALID_CONTACT', 400);
  const [threadResult, historyResult] = await Promise.all([getServiceDB().from('crm_instagram_threads')
    .select('history_synced_at,next_cursor,last_inbound_at,reply_blocked_until')
    .eq('account_id', accountId).eq('contact_id', contactId).maybeSingle(),
    getServiceDB().from('crm_instagram_history').select('body')
    .eq('account_id', accountId).eq('contact_id', contactId)
    .order('created_at', { ascending: false }).order('message_id', { ascending: false }).limit(200)]);
  const thread = check(threadResult), rows = check(historyResult);
  if (!thread) return null;
  return { data: rows.map(r => r.body).reverse(), nextCursor: thread.next_cursor || null,
    syncedAt: thread.history_synced_at, lastInboundAt: thread.last_inbound_at,
    replyBlockedUntil: thread.reply_blocked_until };
}
export async function blockInstagramReply(accountId, contactId) {
  check(await getServiceDB().from('crm_instagram_threads').update({ reply_blocked_until: new Date(Date.now() + 24 * 3600000).toISOString() })
    .eq('account_id', accountId).eq('contact_id', contactId));
}
