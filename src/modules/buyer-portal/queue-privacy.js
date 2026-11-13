import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
const invitePattern=/^\/start(?:@\w+)?\s+buyer_([A-Za-z0-9_-]{43})$/;
export const buyerStartToken = text => invitePattern.exec(text || '')?.[1];
function key(secret) {
  if (!secret) throw new Error('BUYER_QUEUE_NOT_CONFIGURED');
  return createHash('sha256').update(`tozon-buyer-queue-v1:${secret}`).digest();
}
function aad(update) { return Buffer.from(`${update.update_id}:${update.message?.from?.id}:${update.message?.chat?.id}`); }
/** Keep bearer QR tokens out of the durable raw-update queue (also covers polling). */
export function protectBuyerUpdate(update,secret=process.env.TELEGRAM_FINANCE_BOT_TOKEN) {
  const token=buyerStartToken(update.message?.text);
  if (!token) return update;
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(secret),iv);
  cipher.setAAD(aad(update));
  const ciphertext=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);
  return {...update,message:{...update.message,text:'/buyer',buyer_invite:Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64url')}};
}
export function readBuyerUpdateToken(update,secret=process.env.TELEGRAM_FINANCE_BOT_TOKEN) {
  if (!update.message?.buyer_invite) return buyerStartToken(update.message?.text);
  try {
    const value=Buffer.from(update.message.buyer_invite,'base64url');
    if (value.length!==71) throw new Error();
    const decipher=createDecipheriv('aes-256-gcm',key(secret),value.subarray(0,12));
    decipher.setAAD(aad(update)); decipher.setAuthTag(value.subarray(12,28));
    const token=Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString('utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error();
    return token;
  } catch { throw new Error('BUYER_INVITE_UNAVAILABLE'); }
}
