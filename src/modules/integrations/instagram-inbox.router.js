import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { protect } from '../../middleware/auth.middleware.js';
import { getInstagramInboxCredentials } from './instagram-connection.repository.js';
import { createInstagramInboxClient, InboxError } from './instagram-inbox.client.js';
import { liveInboxEnabled } from './instagram-live.repository.js';
import { createInstagramLiveInbox } from './instagram-live.service.js';
import { getServiceDB, getDB } from '../../db/connection.js';

const router = Router();
const getSafeDB = () => {
  try { return getServiceDB(); } catch { return getDB(); }
};

async function getManagerAllowedContacts(userId, accountId) {
  const db = getSafeDB();
  const { data: threads } = await db
    .from('instagram_threads')
    .select('contact_id, instagram_account_id, lead_id, leads!lead_id(responsible_user_id)')
    .eq('instagram_account_id', String(accountId));
  return new Set(
    (threads || [])
      .filter((t) => Number(t.leads?.responsible_user_id) === Number(userId))
      .map((t) => String(t.contact_id))
  );
}

router.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!['ADMIN', 'DIRECTOR', 'SALES_MANAGER'].includes(req.user?.role)) return res.status(403).json({ code: 'INSTAGRAM_ACCESS_DENIED' });
  next();
});
const readLimit = rateLimit({ windowMs: 60000, limit: 90, keyGenerator: req => String(req.user.id),
  standardHeaders: 'draft-8', legacyHeaders: false, message: { code: 'INSTAGRAM_RATE_LIMIT' } });
const sendLimit = rateLimit({ windowMs: 60000, limit: 10, keyGenerator: req => String(req.user.id),
  standardHeaders: 'draft-8', legacyHeaders: false, message: { code: 'INSTAGRAM_RATE_LIMIT' } });
const handle = operation => async (req, res) => {
  try {
    const requestedAccount = req.params.account ?? req.query.account;
    if (requestedAccount !== undefined && (typeof requestedAccount !== 'string' || !/^\d{5,40}$/.test(requestedAccount))) throw new InboxError('INVALID_ACCOUNT', 400);
    const credentials = await getInstagramInboxCredentials(requestedAccount);
    if (!credentials) throw new InboxError(requestedAccount ? 'INSTAGRAM_ACCOUNT_NOT_CONNECTED' : 'INSTAGRAM_RECONNECT_REQUIRED', requestedAccount ? 404 : 409);
    if (req.params.account && req.params.account !== credentials.accountId) throw new InboxError('INSTAGRAM_ACCOUNT_MISMATCH', 404);
    if (req.user?.role === 'SALES_MANAGER' && req.params.contact) {
      const allowed = await getManagerAllowedContacts(req.user.id, credentials.accountId);
      if (!allowed.has(String(req.params.contact))) {
        throw new InboxError('INSTAGRAM_ACCESS_DENIED', 403);
      }
    }
    const result = await operation(liveInboxEnabled() ? createInstagramLiveInbox(credentials) : createInstagramInboxClient(credentials), req, credentials);
    return res.json({ status: 'success', ...result });
  } catch (error) {
    // Do not serialize Graph errors, tokens, customer text, or request URLs.
    return res.status(error instanceof InboxError ? error.status : 503).json({ status: 'error',
      code: error instanceof InboxError ? error.code : 'INSTAGRAM_UNAVAILABLE' });
  }
};
router.get('/inbox/conversations', readLimit, handle(async (client, req, credentials) => {
  const result = await client.conversations();
  if (req.user?.role !== 'SALES_MANAGER') return result;
  const allowed = await getManagerAllowedContacts(req.user.id, credentials.accountId);
  return { ...result, data: (result?.data || []).filter((c) => allowed.has(String(c.contactId))) };
}));
router.get('/inbox/conversations/:account/:contact/messages', readLimit,
  handle((client, req) => client.messages(req.params.contact, req.query.after)));
router.get('/inbox/conversations/page', readLimit,
  handle(async (client, req, credentials) => {
    const result = await client.conversations(req.query.after);
    if (req.user?.role !== 'SALES_MANAGER') return result;
    const allowed = await getManagerAllowedContacts(req.user.id, credentials.accountId);
    return { ...result, data: (result?.data || []).filter((c) => allowed.has(String(c.contactId))) };
  }));
router.post('/send/:account/:contact', sendLimit, handle(async (client, req) => {
  const data = await client.send(req.params.contact, req.body?.text, req.body?.idempotency_key);
  return { data, deliveryStatus: data?.acceptedButUnsaved ? 'unknown' : 'confirmed' };
}));
export default router;
