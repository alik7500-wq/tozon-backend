import { createHash } from 'node:crypto';
import { getServiceDB } from '../../db/connection.js';

export function webhookEventKey(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('Invalid Meta webhook event');
  // Hash of the full signed payload is stable for Meta retries of identical payloads.
  // Separate logical events within one payload remain available for later processing.
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}
export async function persistInstagramWebhookEvent(event) {
  const key = webhookEventKey(event);
  const { error } = await getServiceDB().from('tozon_instagram_webhook_events')
    .upsert({ event_key: key, payload: event }, { onConflict: 'event_key', ignoreDuplicates: true });
  if (error) throw new Error('Failed to durably store Instagram webhook event');
  return { eventKey: key };
}
