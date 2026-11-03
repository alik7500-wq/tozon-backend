import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, raw } from 'express';
import { persistInstagramWebhookEvent } from './instagram-webhook.repository.js';

const router = Router();
const webhookSecret = () => process.env.META_INSTAGRAM_APP_SECRET?.trim();
const verifyToken = () => process.env.META_WEBHOOK_VERIFY_TOKEN?.trim();

router.get('/', (req, res) => {
  const expected = verifyToken();
  const supplied = req.query['hub.verify_token'];
  const mode = req.query['hub.mode'];
  const challenge = req.query['hub.challenge'];
  if (!expected || mode !== 'subscribe' || typeof supplied !== 'string' || typeof challenge !== 'string') {
    return res.sendStatus(403);
  }
  const actual = Buffer.from(supplied);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return res.sendStatus(403);
  res.set('Cache-Control', 'no-store').status(200).type('text/plain').send(challenge);
});

router.post('/', raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  // Verification GET can be deployed independently; never ingest messages until explicitly enabled.
  if (process.env.INSTAGRAM_WEBHOOK_INGEST_ENABLED !== 'true') return res.sendStatus(503);
  const secret = webhookSecret();
  const signature = req.get('x-hub-signature-256');
  if (!secret || !Buffer.isBuffer(req.body) || !signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) {
    return res.sendStatus(403);
  }
  const expected = Buffer.from(createHmac('sha256', secret).update(req.body).digest('hex'), 'hex');
  const actual = Buffer.from(signature.slice(7), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return res.sendStatus(403);
  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }
  try {
    if (payload?.object !== 'instagram' || !Array.isArray(payload.entry)) return res.sendStatus(400);
    // Reject unexpected accounts before storing any customer data.
    const accountId = process.env.INSTAGRAM_INBOX_ACCOUNT_ID;
    if (!/^[0-9]{5,30}$/.test(accountId || '')) return res.sendStatus(503);
    if (payload.entry.some(entry => String(entry?.id || '') !== accountId)) return res.sendStatus(403);
    await persistInstagramWebhookEvent(payload);
    return res.sendStatus(200);
  } catch {
    return res.status(503).json({ status: 'error', code: 'INSTAGRAM_WEBHOOK_STORAGE_UNAVAILABLE' });
  }
});

export default router;
