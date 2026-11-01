import { getServiceDB } from '../../db/connection.js';
import { processInstagramWebhookEvent } from './instagram-message-processor.js';

// Invoke from a trusted server-side scheduler only. Not exposed as a public endpoint.
// Claim one pending event atomically to avoid two workers processing the same row.
export async function runInstagramWebhookQueue({ limit = 20 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid queue limit');
  const db = getServiceDB();
  let processed = 0;
  let failed = 0;
  for (let i = 0; i < limit; i++) {
    const { data, error } = await db.rpc('claim_tozon_instagram_webhook_event');
    if (error) throw new Error('Instagram webhook queue claim failed');
    if (!data) break;
    try {
      await processInstagramWebhookEvent(data);
      processed++;
    } catch {
      failed++;
      const { error: updateError } = await db.from('tozon_instagram_webhook_events')
        .update({ status: 'failed', last_error: 'Processing failed' }).eq('id', data.id);
      if (updateError) throw new Error('Instagram webhook failure recording failed');
    }
  }
  return { processed, failed };
}
