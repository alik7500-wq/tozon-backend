import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangeFacebookBusinessCode, extendFacebookBusinessToken, resolveTozonInstagramAccount } from '../modules/integrations/facebook-business-token.client.js';
const old = { id: process.env.META_INSTAGRAM_APP_ID, secret: process.env.META_INSTAGRAM_APP_SECRET, redirect: process.env.META_INSTAGRAM_REDIRECT_URI };
const originalFetch = globalThis.fetch;
function setup() {
  process.env.META_INSTAGRAM_APP_ID = '1683937156688365';
  process.env.META_INSTAGRAM_APP_SECRET = 'test-secret';
  process.env.META_INSTAGRAM_REDIRECT_URI = 'https://tozon-backend.onrender.com/api/integrations/instagram/callback';
}
afterEach(() => {
  for (const [key, value] of [['META_INSTAGRAM_APP_ID', old.id], ['META_INSTAGRAM_APP_SECRET', old.secret], ['META_INSTAGRAM_REDIRECT_URI', old.redirect]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});
describe('Facebook Business token client', () => {
  it('exchanges a code on graph.facebook.com', async () => {
    setup();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: 'short', expires_in: 3600 }) });
    expect(await exchangeFacebookBusinessCode('code')).toEqual({ accessToken: 'short', expiresIn: 3600 });
    const url = new URL(globalThis.fetch.mock.calls[0][0]);
    expect(url.hostname).toBe('graph.facebook.com');
    expect(url.pathname).toContain('/oauth/access_token');
    expect(url.searchParams.get('redirect_uri')).toBe(process.env.META_INSTAGRAM_REDIRECT_URI);
  });
  it('extends the token with fb_exchange_token', async () => {
    setup();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: 'long', expires_in: 5000000 }) });
    expect((await extendFacebookBusinessToken('short')).accessToken).toBe('long');
    expect(new URL(globalThis.fetch.mock.calls[0][0]).searchParams.get('grant_type')).toBe('fb_exchange_token');
  });
  it('resolves only the expected Instagram account', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: '1', access_token: 'page', instagram_business_account: { id: '17841447499018452' } }] }) });
    expect((await resolveTozonInstagramAccount('user')).pageAccessToken).toBe('page');
  });
  it('rejects other accounts', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: '2', access_token: 'page', instagram_business_account: { id: 'other' } }] }) });
    await expect(resolveTozonInstagramAccount('user')).rejects.toThrow();
  });
});
