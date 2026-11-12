import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { protect } from '../../middleware/auth.middleware.js';
import { getInstagramInboxCredentials } from './instagram-connection.repository.js';
import { createInstagramInboxClient, InboxError } from './instagram-inbox.client.js';
import { liveInboxEnabled } from './instagram-live.repository.js';
import { createInstagramLiveInbox } from './instagram-live.service.js';

const router = Router();
router.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!['ADMIN', 'DIRECTOR'].includes(req.user?.role)) return res.status(403).json({ code: 'INSTAGRAM_ACCESS_DENIED' });
  next();
});
const readLimit = rateLimit({ windowMs: 60000, limit: 90, keyGenerator: req => String(req.user.id),
  standardHeaders: 'draft-8', legacyHeaders: false, message: { code: 'INSTAGRAM_RATE_LIMIT' } });
const sendLimit = rateLimit({ windowMs: 60000, limit: 10, keyGenerator: req => String(req.user.id),
  standardHeaders: 'draft-8', legacyHeaders: false, message: { code: 'INSTAGRAM_RATE_LIMIT' } });
const handle = operation => async (req, res) => {
  try {
    const credentials = await getInstagramInboxCredentials();
    if (!credentials) throw new InboxError('INSTAGRAM_RECONNECT_REQUIRED', 409);
    if (req.params.account && req.params.account !== credentials.accountId) throw new InboxError('INSTAGRAM_ACCOUNT_MISMATCH', 404);
    const result = await operation(liveInboxEnabled() ? createInstagramLiveInbox(credentials) : createInstagramInboxClient(credentials), req);
    return res.json({ status: 'success', ...result });
  } catch (error) {
    // Do not serialize Graph errors, tokens, customer text, or request URLs.
    return res.status(error instanceof InboxError ? error.status : 503).json({ status: 'error',
      code: error instanceof InboxError ? error.code : 'INSTAGRAM_UNAVAILABLE' });
  }
};
router.get('/inbox/conversations', readLimit, handle(client => client.conversations()));
router.get('/inbox/conversations/:account/:contact/messages', readLimit,
  handle((client, req) => client.messages(req.params.contact, req.query.after)));
router.get('/inbox/conversations/page', readLimit,
  handle((client, req) => client.conversations(req.query.after)));
router.post('/send/:account/:contact', sendLimit, handle(async (client, req) => ({ data: await client.send(req.params.contact, req.body?.text) })));
export default router;
