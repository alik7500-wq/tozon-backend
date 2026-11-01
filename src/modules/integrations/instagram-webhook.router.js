import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, raw } from 'express';

const router = Router();
const webhookSecret = () => process.env.META_APP_SECRET?.trim();
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

router.post('/', raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
  const secret = webhookSecret();
  const signature = req.get('x-hub-signature-256');
  if (!secret || !Buffer.isBuffer(req.body) || !signature || !/^sha256=[a-f0-9]{64}$/i.test(signature)) {
    return res.sendStatus(403);
  }
  const expected = Buffer.from(createHmac('sha256', secret).update(req.body).digest('hex'), 'hex');
  const actual = Buffer.from(signature.slice(7), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return res.sendStatus(403);
  // Do not acknowledge and drop valid events before durable storage and deduplication exist.
  return res.status(503).json({ status: 'error', code: 'INSTAGRAM_WEBHOOK_PROCESSOR_NOT_READY' });
});

export default router;
