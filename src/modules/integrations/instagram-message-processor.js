import { getServiceDB } from '../../db/connection.js';
import { extractInstagramMessages } from './instagram-message-normalizer.js';

// Replay-safe: Meta message.mid is the unique key. Process only stored signed events.
export async function processInstagramWebhookEvent(eventRow) {
  if (!eventRow?.id || !eventRow?.payload) throw new TypeError('Stored webhook event required');
  const db = getServiceDB();
  const messages = extractInstagramMessages(eventRow.payload);
  for (const message of messages) {
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
  }
  const { error } = await db.from('tozon_instagram_webhook_events')
    .update({ status: 'processed', processed_at: new Date().toISOString(), last_error: null })
    .eq('id', eventRow.id);
  if (error) throw new Error('Instagram webhook completion update failed');
  return { processedMessages: messages.length };
}
