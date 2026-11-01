import { afterEach, describe, expect, it, vi } from 'vitest';
import { instagramAuthorizationUrl, exchangeInstagramAuthorizationCode, exchangeInstagramLongLivedToken, fetchInstagramProfile } from '../modules/integrations/instagram-meta.client.js';

const original = {
  META_INSTAGRAM_APP_ID: process.env.META_INSTAGRAM_APP_ID,
  META_INSTAGRAM_APP_SECRET: process.env.META_INSTAGRAM_APP_SECRET,
  META_INSTAGRAM_REDIRECT_URI: process.env.META_INSTAGRAM_REDIRECT_URI
};
const originalFetch = globalThis.fetch;
const setConfig = () => {
  process.env.META_INSTAGRAM_APP_ID = '12345';
  process.env.META_INSTAGRAM_APP_SECRET = 'test-secret';
  process.env.META_INSTAGRAM_REDIRECT_URI = 'https://example.com/api/integrations/instagram/callback';
};
afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('Instagram Login Meta client', () => {
  it('requires complete HTTPS configuration', () => {
    delete process.env.META_INSTAGRAM_APP_ID;
    expect(() => instagramAuthorizationUrl('safe-state')).toThrow();
  });

  it('constructs the Instagram authorization URL with the exact redirect', () => {
    setConfig();
    const url = new URL(instagramAuthorizationUrl('safe-state'));
    expect(url.hostname).toBe('www.instagram.com');
    expect(url.searchParams.get('state')).toBe('safe-state');
    expect(url.searchParams.get('redirect_uri')).toBe(process.env.META_INSTAGRAM_REDIRECT_URI);
    expect(url.searchParams.get('scope')).toContain('instagram_business_manage_messages');
  });

  it('exchanges a short-lived token without exposing the secret in a URL', async () => {
    setConfig();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'short-token', user_id: 123 })
    });
    await expect(exchangeInstagramAuthorizationCode('auth-code')).resolves.toEqual({
      accessToken: 'short-token', instagramUserId: '123'
    });
    const [url, options] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://api.instagram.com/oauth/access_token');
    expect(options.method).toBe('POST');
    expect(options.body.get('client_secret')).toBe('test-secret');
  });

  it('exchanges a long-lived token and loads profile', async () => {
    setConfig();
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'long-token', expires_in: 5184000 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ user_id: '123', username: 'tozon_plaza' }) });
    await expect(exchangeInstagramLongLivedToken('short-token')).resolves.toEqual({
      accessToken: 'long-token', expiresIn: 5184000
    });
    await expect(fetchInstagramProfile('long-token')).resolves.toEqual({
      userId: '123', username: 'tozon_plaza'
    });
  });

  it('rejects Meta errors without returning response details', async () => {
    setConfig();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: 'sensitive upstream details' } })
    });
    await expect(exchangeInstagramAuthorizationCode('auth-code')).rejects.toThrow('Instagram API request failed');
  });
});
