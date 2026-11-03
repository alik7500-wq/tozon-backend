// Isolated Meta Messenger API client for Instagram Direct. Not wired to a route
// until permissions, account scoping, and the messaging window are validated.
const GRAPH_BASE = 'https://graph.facebook.com/v25.0';
export async function sendInstagramDirectMessage({ pageAccessToken, recipientId, text, request = fetch }) {
  if (typeof pageAccessToken !== 'string' || !pageAccessToken) throw new TypeError('Page token required');
  if (typeof recipientId !== 'string' || !/^[0-9]{5,30}$/.test(recipientId)) throw new TypeError('Invalid Instagram recipient');
  if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new TypeError('Invalid Instagram message');
  const response = await request(GRAPH_BASE + '/me/messages', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + pageAccessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: { text: text.trim() } }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response?.ok) throw new Error('Instagram message delivery failed');
  const body = await response.json().catch(() => null);
  if (!body || typeof body.message_id !== 'string' || !body.message_id) throw new Error('Instagram delivery confirmation missing');
  return { messageId: body.message_id };
}
