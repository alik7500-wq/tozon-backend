import { getServiceDB } from '../../db/connection.js';
import { extractInstagramMessages } from './instagram-message-normalizer.js';

// Replay-safe: Meta message.mid is the unique key. Process only stored signed events.
export async function processInstagramWebhookEvent(eventRow) {
  if (!eventRow?.id || !eventRow?.payload || eventRow.status !== 'processing' || !Number.isInteger(eventRow.attempts)) throw new TypeError('Stored webhook event required');
  const db = getServiceDB();
  const messages = extractInstagramMessages(eventRow.payload);
  const expectedAccountId = process.env.INSTAGRAM_INBOX_ACCOUNT_ID;
  if (!/^[0-9]{5,30}$/.test(expectedAccountId || '')) throw new Error('Instagram account configuration missing');
  // TOZON-only: never persist messages belonging to a different Instagram business account.
  let saved = 0;
  for (const message of messages) {
    if (message.instagramAccountId !== expectedAccountId) continue;
    const { error } = await db.from('tozon_instagram_messages').upsert({
      message_id: message.messageId,
      instagram_account_id: message.instagramAccountId,
      sender_id: message.senderId,
      recipient_id: message.recipientId,
      message_timestamp: message.timestamp,
      text_content: message.text,
      is_echo: message.isEcho,
      has_attachments: message.hasAttachments
    }, { onConflict: 'message_id', ignoreDuplicates: true });
    if (error) throw new Error('Instagram message persistence failed');
    saved++;
  }
  const { error, count } = await db.from('tozon_instagram_webhook_events')
    .update({ status: 'processed', processed_at: new Date().toISOString(), last_error: null }, { count: 'exact' })
    .eq('id', eventRow.id)
    .eq('status', 'processing')
    .eq('attempts', eventRow.attempts);
  if (error || count !== 1) throw new Error('Instagram webhook completion update failed');
  return { processedMessages: saved };
}
