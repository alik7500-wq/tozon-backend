import { createHmac, timingSafeEqual, randomBytes, createHash } from 'node:crypto';

/** Authentication only. A verified Telegram identity never grants contract access. */
export function verifyMiniAppInitData(raw, botToken, { now = Date.now(), maxAgeSeconds = 300 } = {}) {
  const denied = () => { throw new Error('INVALID_TELEGRAM_AUTH'); };
  if (typeof raw !== 'string' || !raw || raw.length > 16384 || !botToken) return denied();
  if (!Number.isFinite(now) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) return denied();
  const params = new URLSearchParams(raw);
  const keys = new Set();
  for (const [key] of params) {
    if (keys.has(key)) return denied();
    keys.add(key);
  }
  const hash = params.get('hash');
  if (!/^[a-f0-9]{64}$/i.test(hash || '')) return denied();
  const check = [...params.entries()].filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return denied();
  const authDate = params.get('auth_date');
  if (!/^\d+$/.test(authDate || '')) return denied();
  const age = Math.floor(now / 1000) - Number(authDate);
  if (!Number.isSafeInteger(Number(authDate)) || age < 0 || age > maxAgeSeconds) return denied();
  let user;
  try { user = JSON.parse(params.get('user')); } catch { return denied(); }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot === true) return denied();
  return Object.freeze({ telegramUserId: String(user.id), authenticatedAt: Number(authDate) });
}

/** Store only the digest; redemption must atomically check expiry and consume once. */
export function createBuyerInviteToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashBuyerInviteToken(token) };
}

export function hashBuyerInviteToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('INVALID_INVITE');
  return createHash('sha256').update(token).digest('hex');
}
