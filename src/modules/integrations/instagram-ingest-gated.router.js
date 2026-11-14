import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Router, raw } from 'express';
import { getServiceDB } from '../../db/connection.js';
import { liveInboxEnabled } from './instagram-live.repository.js';
import { processInstagramWebhook } from './instagram-webhook.processor.js';
import { connectedInstagramAccountIds } from './instagram-connection.repository.js';

const router = Router();
// This endpoint is inert until a separate, explicit rollout flag is enabled.
// The existing GET challenge verification remains registered in app.js.
router.post('/', raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (process.env.INSTAGRAM_WEBHOOK_INGEST_ENABLED !== 'true') return res.sendStatus(503);
  const secret = process.env.META_INSTAGRAM_APP_SECRET?.trim();
  const signature = req.get('x-hub-signature-256');
  if (!secret || !Buffer.isBuffer(req.body) || !/^sha256=[a-f0-9]{64}$/i.test(signature || '')) return res.sendStatus(403);
  const actual = Buffer.from(signature.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(req.body).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return res.sendStatus(403);
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); }
  catch { return res.sendStatus(400); }
  if (payload?.object !== 'instagram' || !Array.isArray(payload.entry)) return res.sendStatus(400);
  try {
    const registered = await connectedInstagramAccountIds();
    // Validate the entire signed envelope before persisting any of its entries.
    if (payload.entry.some(entry => !registered.has(String(entry?.id || '')))) return res.sendStatus(403);
    for (const entry of payload.entry) {
      const accountId = String(entry.id);
      const accountPayload = { object: 'instagram', entry: [entry] };
      const eventKey = createHash('sha256').update(JSON.stringify(accountPayload)).digest('hex');
      const { error } = await getServiceDB().from('tozon_instagram_webhook_events')
        .upsert({ event_key: eventKey, instagram_user_id: accountId, payload: accountPayload }, { onConflict: 'event_key', ignoreDuplicates: true });
      if (error) throw error;
      if (liveInboxEnabled()) {
        await processInstagramWebhook(accountPayload, accountId);
        const { error: processedError } = await getServiceDB().from('tozon_instagram_webhook_events')
          .update({ status: 'processed', processed_at: new Date().toISOString() }).eq('event_key', eventKey);
        if (processedError) throw processedError;
      }
    }
    return res.sendStatus(200);
  } catch {
    return res.status(503).json({ code: 'INSTAGRAM_WEBHOOK_STORAGE_UNAVAILABLE' });
  }
});
export default router;
