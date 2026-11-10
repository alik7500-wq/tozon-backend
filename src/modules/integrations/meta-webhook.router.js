import { Router, raw } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeMetaWebhook } from './meta-webhook-events.js';
import { MetaEvents } from './meta-events.repository.js';

const router = Router();
export const metaIngestEnabled = () => process.env.META_SOURCE_ROUTING_ENABLED === 'true' && process.env.META_SOURCE_INGEST_ENABLED === 'true';
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/', (req, res) => {
  const token = process.env.META_SOURCES_WEBHOOK_VERIFY_TOKEN;
  const supplied = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (!metaIngestEnabled() || !token || req.query['hub.mode'] !== 'subscribe' || typeof supplied !== 'string' ||
      typeof challenge !== 'string' || challenge.length > 512) return res.sendStatus(403);
  const actual = Buffer.from(supplied); const expected = Buffer.from(token);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return res.sendStatus(403);
  return res.type('text/plain').send(challenge);
});
router.post('/', raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  if (!metaIngestEnabled()) return res.sendStatus(503);
  const secret = process.env.META_INSTAGRAM_APP_SECRET;
  const signature = req.get('x-hub-signature-256');
  if (!secret || !Buffer.isBuffer(req.body) || !/^sha256=[a-f0-9]{64}$/i.test(signature || '')) return res.sendStatus(403);
  const actual = Buffer.from(signature.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(req.body).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return res.sendStatus(403);
  let events;
  try { events = normalizeMetaWebhook(JSON.parse(req.body.toString('utf8'))); }
  catch { return res.sendStatus(400); }
  try {
    if (events.length) await MetaEvents.enqueue(events);
    // Acknowledge only after durable storage. No Meta fetches in this callback.
    return res.status(200).json({ received: true });
  } catch { return res.sendStatus(503); }
});
export default router;
