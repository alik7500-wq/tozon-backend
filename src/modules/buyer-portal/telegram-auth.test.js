import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyMiniAppInitData, createBuyerInviteToken, hashBuyerInviteToken } from './telegram-auth.js';

const token = 'test-only-bot-token';
const now = 1800000000000;
function signed(fields = {}) {
  const p = new URLSearchParams({ auth_date: String(now / 1000), user: JSON.stringify({ id: 12345 }), ...fields });
  const check = [...p].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  p.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}
describe('buyer Mini App authentication', () => {
  it('returns only verified identity, never client ownership claims', () => {
    expect(verifyMiniAppInitData(signed({ contract_id: '999' }), token, { now })).toEqual({ telegramUserId: '12345', authenticatedAt: now / 1000 });
  });
  it.each([
    () => signed().replace('12345', '98765'),
    () => signed() + '&user=%7B%22id%22%3A98765%7D',
    () => signed({ auth_date: String(now / 1000 - 301) }),
    () => signed({ auth_date: String(now / 1000 + 1) }),
    () => signed({ user: 'invalid' }),
    () => signed({ user: JSON.stringify({ id: -1 }) }),
    () => signed({ user: JSON.stringify({ id: 123, is_bot: true }) }),
    () => signed({ auth_date: '1e9' }),
    () => 'hash=bad',
  ])('rejects invalid, stale, duplicate or altered data', make => {
    expect(() => verifyMiniAppInitData(make(), token, { now })).toThrow('INVALID_TELEGRAM_AUTH');
  });
  it('rejects the wrong bot and missing configuration', () => {
    for (const wrong of ['', 'other-token']) expect(() => verifyMiniAppInitData(signed(), wrong, { now })).toThrow();
  });
  it('accepts the TTL boundary', () => {
    expect(verifyMiniAppInitData(signed({ auth_date: String(now / 1000 - 300) }), token, { now }).telegramUserId).toBe('12345');
  });
});
describe('buyer QR token', () => {
  it('is opaque, fits Telegram start payload, and stores a digest', () => {
    const a = createBuyerInviteToken(); const b = createBuyerInviteToken();
    expect(a.token).not.toBe(b.token);
    expect(`buyer_${a.token}`.length).toBeLessThanOrEqual(64);
    expect(a.tokenHash).toBe(hashBuyerInviteToken(a.token));
    expect(a.tokenHash).not.toBe(a.token);
  });
  it.each(['', '42', '../secret', 'x'.repeat(100)])('rejects malformed tokens', value => {
    expect(() => hashBuyerInviteToken(value)).toThrow('INVALID_INVITE');
  });
});
