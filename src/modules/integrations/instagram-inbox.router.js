import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { protect } from '../../middleware/auth.middleware.js';
import { hasSection, isMatrixUser } from '../../middleware/sectionAccess.js';
import { getInstagramInboxCredentials, getTozonInstagramConnectionStatus } from './instagram-connection.repository.js';
import { createInstagramInboxClient, InboxError } from './instagram-inbox.client.js';
import { liveInboxEnabled } from './instagram-live.repository.js';
import { createInstagramLiveInbox } from './instagram-live.service.js';
import { getServiceDB, getDB } from '../../db/connection.js';

const router = Router();
const getSafeDB = () => {
  try { return getServiceDB(); } catch { return getDB(); }
};

function hasInstagramInboxPermission(user, isWrite = false) {
  if (!user) return false;
  if (isMatrixUser(user)) {
    return hasSection(user, 'leads.view', isWrite);
  }
  if (['ADMIN', 'DIRECTOR'].includes(user.role)) return true;
  const perms = Array.isArray(user.permissions) ? user.permissions : [];
  if (perms.includes('*')) return true;
  if (isWrite) return perms.includes('leads.manage');
  return perms.includes('leads.view') || perms.includes('leads.manage');
}

function isThreadScopedUser(user) {
  if (!user) return true;
  if (user.role === 'SALES_MANAGER') return true;
  if (user.role === 'ADMIN' && user.all_projects_access !== false && !Array.isArray(user.allowed_project_ids)) {
    return false;
  }
  // Restricted DIRECTOR / explicit project-scoped ADMIN (R04.2)
  return user.all_projects_access !== true;
}

async function getScopedInstagramThreads(user, accountId = null) {
  const hasAllProjects = user?.all_projects_access === true;
  const allowedProjects = new Set(
    Array.isArray(user?.allowed_project_ids) ? user.allowed_project_ids.map(String) : []
  );

  // Fail-closed on empty/missing project permissions when user does not have global project access
  if (!hasAllProjects && allowedProjects.size === 0) {
    return [];
  }

  const db = getSafeDB();
  let query = db
    .from('instagram_threads')
    .select('contact_id, instagram_account_id, lead_id, leads!lead_id(id, responsible_user_id, interested_project_id)');
  if (accountId !== null && accountId !== undefined) {
    query = query.eq('instagram_account_id', String(accountId));
  }
  const { data: threads, error } = await query;
  if (error) {
    throw new InboxError('INSTAGRAM_SCOPE_UNAVAILABLE', 503);
  }

  return (threads || []).filter((t) => {
    const lead = t.leads;
    if (!lead) return false;
    if (user.role === 'SALES_MANAGER' && Number(lead.responsible_user_id) !== Number(user.id)) {
      return false;
    }
    if (!hasAllProjects) {
      if (lead.interested_project_id === null || lead.interested_project_id === undefined) return false;
      if (!allowedProjects.has(String(lead.interested_project_id))) return false;
    }
    return true;
  });
}

async function getAllowedContactsForAccount(user, accountId) {
  const threads = await getScopedInstagramThreads(user, accountId);
  return new Set(threads.map((t) => String(t.contact_id)));
}

router.use(protect, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!['ADMIN', 'DIRECTOR', 'SALES_MANAGER'].includes(req.user?.role)) {
    return res.status(403).json({ code: 'INSTAGRAM_ACCESS_DENIED' });
  }
  next();
});
const readLimit = rateLimit({ windowMs: 60000, limit: 90, keyGenerator: req => String(req.user.id),
  standardHeaders: 'draft-8', legacyHeaders: false, message: { code: 'INSTAGRAM_RATE_LIMIT' } });
const sendLimit = rateLimit({ windowMs: 60000, limit: 10, keyGenerator: req => String(req.user.id),
  standardHeaders: 'draft-8', legacyHeaders: false, message: { code: 'INSTAGRAM_RATE_LIMIT' } });

// Safe account list for inbox users (no tokens, no OAuth settings)
router.get('/inbox/accounts', readLimit, async (req, res) => {
  try {
    if (!hasInstagramInboxPermission(req.user, false)) {
      return res.status(403).json({ status: 'error', code: 'INSTAGRAM_ACCESS_DENIED' });
    }
    const status = await getTozonInstagramConnectionStatus();
    const connectedAccounts = (status?.accounts || [])
      .filter((a) => a.connected)
      .map((a) => ({ accountId: String(a.accountId), username: a.username || null }));

    if (!isThreadScopedUser(req.user)) {
      return res.json({ status: 'success', data: { accounts: connectedAccounts } });
    }

    const scopedThreads = await getScopedInstagramThreads(req.user);
    const allowedAccountIds = new Set(scopedThreads.map((t) => String(t.instagram_account_id)));
    return res.json({
      status: 'success',
      data: { accounts: connectedAccounts.filter((a) => allowedAccountIds.has(a.accountId)) }
    });
  } catch (error) {
    return res.status(error instanceof InboxError ? error.status : 503).json({
      status: 'error',
      code: error instanceof InboxError ? error.code : 'INSTAGRAM_UNAVAILABLE'
    });
  }
});

const handle = (operation, { isWrite = false } = {}) => async (req, res) => {
  try {
    if (!hasInstagramInboxPermission(req.user, isWrite)) {
      throw new InboxError('INSTAGRAM_ACCESS_DENIED', 403);
    }
    let requestedAccount = req.params.account ?? req.query.account;
    if (requestedAccount !== undefined && (typeof requestedAccount !== 'string' || !/^\d{5,40}$/.test(requestedAccount))) {
      throw new InboxError('INVALID_ACCOUNT', 400);
    }

    const scoped = isThreadScopedUser(req.user);
    if (scoped && !req.params.contact) {
      const scopedThreads = await getScopedInstagramThreads(req.user, requestedAccount ?? null);
      if (scopedThreads.length === 0) {
        return res.json({ status: 'success', data: [], nextCursor: null });
      }
      if (!requestedAccount) {
        const distinctAccounts = [...new Set(scopedThreads.map((t) => String(t.instagram_account_id)))];
        if (distinctAccounts.length === 1) {
          requestedAccount = distinctAccounts[0];
        }
      }
    }

    const credentials = await getInstagramInboxCredentials(requestedAccount);
    if (!credentials) throw new InboxError(requestedAccount ? 'INSTAGRAM_ACCOUNT_NOT_CONNECTED' : 'INSTAGRAM_RECONNECT_REQUIRED', requestedAccount ? 404 : 409);
    if (req.params.account && req.params.account !== credentials.accountId) throw new InboxError('INSTAGRAM_ACCOUNT_MISMATCH', 404);

    if (scoped && req.params.contact) {
      const allowed = await getAllowedContactsForAccount(req.user, credentials.accountId);
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
  if (isThreadScopedUser(req.user)) {
    const allowed = await getAllowedContactsForAccount(req.user, credentials.accountId);
    if (allowed.size === 0) return { data: [], nextCursor: null };
    const result = await client.conversations();
    return { ...result, data: (result?.data || []).filter((c) => allowed.has(String(c.contactId))) };
  }
  return client.conversations();
}));
router.get('/inbox/conversations/:account/:contact/messages', readLimit,
  handle((client, req) => client.messages(req.params.contact, req.query.after)));
router.get('/inbox/conversations/page', readLimit,
  handle(async (client, req, credentials) => {
    if (isThreadScopedUser(req.user)) {
      const allowed = await getAllowedContactsForAccount(req.user, credentials.accountId);
      if (allowed.size === 0) return { data: [], nextCursor: null };
      const result = await client.conversations(req.query.after);
      return { ...result, data: (result?.data || []).filter((c) => allowed.has(String(c.contactId))) };
    }
    return client.conversations(req.query.after);
  }));
router.post('/send/:account/:contact', sendLimit, handle(async (client, req) => {
  const data = await client.send(req.params.contact, req.body?.text, req.body?.idempotency_key);
  return { data, deliveryStatus: data?.acceptedButUnsaved ? 'unknown' : 'confirmed' };
}, { isWrite: true }));
export default router;
