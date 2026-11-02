import { Router } from 'express';
import { protect } from '../../middleware/auth.middleware.js';
import { getServiceDB } from '../../db/connection.js';
import { verifyInstagramAssignmentTenant } from './instagram-tenant-ownership.js';

const router = Router();
router.use(protect);
router.use((req, res, next) => {
  if (!['ADMIN', 'DIRECTOR'].includes(req.user?.role)) return res.sendStatus(403);
  if (process.env.INSTAGRAM_ASSIGNMENTS_ENABLED !== 'true' ||
      !/^[0-9]{5,30}$/.test(process.env.INSTAGRAM_INBOX_ACCOUNT_ID || '')) {
    return res.status(503).json({ status: 'error', code: 'INSTAGRAM_ASSIGNMENTS_NOT_ENABLED' });
  }
  next();
});

// TOZON-only preparatory endpoint. No manager read/send rights are granted here.
router.post('/:accountId/:contactId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { accountId, contactId } = req.params;
  const managerId = req.body?.managerId;
  if (!/^[0-9]{5,30}$/.test(accountId) || !/^[0-9]{5,30}$/.test(contactId) ||
      !Number.isSafeInteger(managerId) || managerId <= 0) {
    return res.status(400).json({ status: 'error', code: 'INVALID_ASSIGNMENT' });
  }
  if (accountId !== process.env.INSTAGRAM_INBOX_ACCOUNT_ID) return res.sendStatus(403);
  const db = getServiceDB();
  const { data: user, error: userError } = await db.from('users')
    .select('id,role,is_active').eq('id', managerId).maybeSingle();
  if (userError) return res.status(503).json({ status: 'error', code: 'USERS_UNAVAILABLE' });
  if (!user || user.role !== 'MANAGER' || user.is_active !== 1) {
    return res.status(422).json({ status: 'error', code: 'INVALID_MANAGER' });
  }
  const { data: messages, error: messagesError } = await db.from('tozon_instagram_messages')
    .select('message_id').eq('instagram_account_id', accountId)
    .eq('sender_id', contactId).limit(1);
  if (messagesError) return res.status(503).json({ status: 'error', code: 'INSTAGRAM_MESSAGES_UNAVAILABLE' });
  if (!messages?.length) return res.status(404).json({ status: 'error', code: 'CONVERSATION_NOT_FOUND' });
  // No tenant ID is inferred from the request: this endpoint is intentionally disabled
  // until authoritative TOZON tenant ownership and the assignment table are installed.
  if (!process.env.INSTAGRAM_TOZON_TENANT_ID) {
    return res.status(503).json({ status: 'error', code: 'INSTAGRAM_TENANT_NOT_CONFIGURED' });
  }
  const tenantId = process.env.INSTAGRAM_TOZON_TENANT_ID;
  const ownershipVerified = await verifyInstagramAssignmentTenant({
    db, tenantId, accountId, managerId, actorId: req.user.id
  });
  if (!ownershipVerified) return res.status(403).json({ status: 'error', code: 'INSTAGRAM_TENANT_OWNERSHIP_DENIED' });
  const { error } = await db.from('tozon_instagram_conversation_assignments').upsert({
    instagram_account_id: accountId, contact_id: contactId,
    tenant_id: process.env.INSTAGRAM_TOZON_TENANT_ID,
    assigned_user_id: managerId, assigned_by_user_id: req.user.id,
    updated_at: new Date().toISOString()
  }, { onConflict: 'instagram_account_id,contact_id' });
  if (error) return res.status(503).json({ status: 'error', code: 'INSTAGRAM_ASSIGNMENT_UNAVAILABLE' });
  return res.json({ status: 'success', data: { accountId, contactId, managerId } });
});
export default router;
