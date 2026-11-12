import { instagramMessageContent, instagramMessagePreview } from './instagram-message-content.js';
import { saveInstagramThread } from './instagram-live.repository.js';

export function instagramWebhookMessages(payload, accountId, now = Date.now()) {
  const result = [];
  for (const entry of payload.entry || []) {
    if (String(entry.id) !== accountId) throw new Error('ACCOUNT_MISMATCH');
    for (const event of entry.messaging || []) {
      const message = event.message;
      if (!message?.mid || typeof message.mid !== 'string' || message.mid.length > 2048) continue;
      const sender = String(event.sender?.id || ''), recipient = String(event.recipient?.id || '');
      const echo = sender === accountId;
      if ((!echo && recipient !== accountId) || (echo && recipient === accountId)) throw new Error('PARTICIPANT_MISMATCH');
      const contactId = echo ? recipient : sender;
      if (!/^\d{1,40}$/.test(contactId)) throw new Error('INVALID_CONTACT');
      const timestamp = Number(event.timestamp);
      if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now + 300000) continue;
      const content = instagramMessageContent({ ...message, message: message.is_deleted ? '' : message.text });
      const body = { ...content, message_id: message.mid, created_at: new Date(timestamp).toISOString(),
        is_echo: echo, deleted: message.is_deleted === true };
      result.push({ thread: { contactId, lastMessage: message.is_deleted ? 'Сообщение удалено' : instagramMessagePreview({ ...message, message: message.text }), updatedAt: body.created_at }, body });
    }
  }
  return result;
}
export async function processInstagramWebhook(payload, accountId) {
  for (const { thread, body } of instagramWebhookMessages(payload, accountId)) {
    await saveInstagramThread(accountId, thread, [body]);
  }
}
