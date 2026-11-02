import { Router } from 'express';
import { protect } from '../../middleware/auth.middleware.js';
import { getServiceDB } from '../../db/connection.js';
import { decryptSocialToken } from './social-token-crypto.js';
import { sendInstagramDirectMessage } from './instagram-message-send.client.js';

// Mounted behind a disabled-by-default feature gate; do not enable before Meta verification.
const router = Router();
router.use(protect);
router.post('/:accountId/:contactId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (process.env.INSTAGRAM_INBOX_SEND_ENABLED !== 'true') return res.sendStatus(503);
  if (!['ADMIN', 'DIRECTOR'].includes(req.user?.role)) return res.sendStatus(403);
  const { accountId, contactId } = req.params;
  const text = req.body?.text;
  if (accountId !== process.env.INSTAGRAM_INBOX_ACCOUNT_ID) return res.sendStatus(403);
  if (!/^\d{5,30}$/.test(contactId) || typeof text !== 'string' || !text.trim() || text.length > 1000) return res.sendStatus(400);
  try {
    const db = getServiceDB();
    const { data: connections, error } = await db.from('tozon_instagram_connections')
      .select('encrypted_access_token,granted_scopes,token_expires_at')
      .eq('instagram_user_id', accountId).eq('status', 'connected').limit(1);
    const connection = connections?.[0];
    if (error || !connection?.encrypted_access_token || !connection.granted_scopes?.includes('instagram_manage_messages') ||
        (connection.token_expires_at && Date.parse(connection.token_expires_at) <= Date.now())) return res.sendStatus(503);
    const { data: inbound, error: readError } = await db.from('tozon_instagram_messages')
      .select('received_at,message_timestamp').eq('instagram_account_id', accountId).eq('sender_id', contactId)
      .eq('is_echo', false).order('received_at', { ascending: false }).limit(1);
    if (readError) return res.sendStatus(503);
    const record = inbound?.[0];
    const ingestedAt = Date.parse(record?.received_at || '');
    const rawTimestamp = Number(record?.message_timestamp);
    // Fail closed: use the older of the Meta event time and ingestion time.
    // Never extend the reply window because a webhook was delivered late.
    const eventAt = Number.isFinite(rawTimestamp) && rawTimestamp > 0
      ? (rawTimestamp < 1e11 ? rawTimestamp * 1000 : rawTimestamp) : NaN;
    const lastReceived = Math.min(ingestedAt, eventAt);
    if (!Number.isFinite(lastReceived) || lastReceived > Date.now() || Date.now() - lastReceived >= 86400000) return res.sendStatus(409);
    const { messageId } = await sendInstagramDirectMessage({
      pageAccessToken: decryptSocialToken(connection.encrypted_access_token), recipientId: contactId, text
    });
    const { error: writeError } = await db.from('tozon_instagram_messages').upsert({
      message_id: messageId, instagram_account_id: accountId, sender_id: accountId,
      recipient_id: contactId, text_content: text.trim(), message_timestamp: Date.now(),
      is_echo: true, has_attachments: false
    }, { onConflict: 'message_id', ignoreDuplicates: true });
    if (writeError) return res.status(503).json({ code: 'SENT_NOT_SAVED' });
    return res.status(201).json({ data: { messageId } });
  } catch {
    return res.status(503).json({ code: 'INSTAGRAM_SEND_UNAVAILABLE' });
  }
});
export default router;
