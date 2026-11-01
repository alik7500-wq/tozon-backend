// Pure normalization: no database access and no external API calls.
export function extractInstagramMessages(payload) {
  if (payload?.object !== 'instagram' || !Array.isArray(payload.entry)) return [];
  const messages = [];
  for (const entry of payload.entry) {
    for (const item of Array.isArray(entry.messaging) ? entry.messaging : []) {
      const message = item.message;
      if (!message || typeof message.mid !== 'string' || !message.mid.trim()) continue;
      if (!item.sender?.id || !item.recipient?.id) continue;
      messages.push({
        messageId: message.mid,
        senderId: String(item.sender.id),
        recipientId: String(item.recipient.id),
        instagramAccountId: String(entry.id || ''),
        timestamp: Number.isFinite(Number(item.timestamp)) ? Number(item.timestamp) : null,
        text: typeof message.text === 'string' ? message.text : null,
        isEcho: message.is_echo === true,
        hasAttachments: Array.isArray(message.attachments) && message.attachments.length > 0
      });
    }
  }
  return messages;
}
