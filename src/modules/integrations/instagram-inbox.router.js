import { Router } from 'express';
import { protect } from '../../middleware/auth.middleware.js';
import { getServiceDB } from '../../db/connection.js';

const router = Router();
router.use(protect);
router.use((req, res, next) => {
  if (!['ADMIN', 'DIRECTOR'].includes(req.user?.role)) return res.sendStatus(403);
  next();
});

// Read-only until tenant-aware access controls and assignment rules are implemented.
router.get('/conversations', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const { data, error } = await getServiceDB().from('tozon_instagram_messages')
    .select('instagram_account_id,sender_id,recipient_id,message_timestamp,text_content,is_echo,received_at')
    .order('received_at', { ascending: false }).limit(500);
  if (error) return res.status(503).json({ status: 'error', code: 'INSTAGRAM_MESSAGES_UNAVAILABLE' });
  const conversations = new Map();
  for (const message of data || []) {
    const contactId = message.is_echo ? message.recipient_id : message.sender_id;
    const key = message.instagram_account_id + ':' + contactId;
    if (!conversations.has(key)) conversations.set(key, {
      instagramAccountId: message.instagram_account_id,
      contactId,
      lastMessage: message.text_content,
      lastMessageAt: message.message_timestamp || message.received_at
    });
  }
  return res.json({ status: 'success', data: [...conversations.values()] });
});
export default router;
