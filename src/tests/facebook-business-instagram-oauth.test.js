import { describe, expect, it, afterEach } from 'vitest';
import { facebookBusinessInstagramAuthorizationUrl } from '../modules/integrations/facebook-business-instagram-oauth.js';
const originalId = process.env.META_INSTAGRAM_APP_ID;
const originalRedirect = process.env.META_INSTAGRAM_REDIRECT_URI;
afterEach(() => {
  if (originalId === undefined) delete process.env.META_INSTAGRAM_APP_ID;
  else process.env.META_INSTAGRAM_APP_ID = originalId;
  if (originalRedirect === undefined) delete process.env.META_INSTAGRAM_REDIRECT_URI;
  else process.env.META_INSTAGRAM_REDIRECT_URI = originalRedirect;
});
describe('Meta Facebook Login for Business', () => {
  it('uses the correct configuration and callback', () => {
    process.env.META_INSTAGRAM_APP_ID = '1683937156688365';
    process.env.META_INSTAGRAM_REDIRECT_URI = 'https://tozon-backend.onrender.com/api/integrations/instagram/callback';
    const url = new URL(facebookBusinessInstagramAuthorizationUrl('12345678901234567890123456789012'));
    expect(url.hostname).toBe('www.facebook.com');
    expect(url.searchParams.get('config_id')).toBe('1881770219479925');
    expect(url.searchParams.get('client_id')).toBe('1683937156688365');
    expect(url.searchParams.get('state')).toHaveLength(32);
  });
  it('rejects missing config and weak state', () => {
    delete process.env.META_INSTAGRAM_APP_ID;
    expect(() => facebookBusinessInstagramAuthorizationUrl('12345678901234567890123456789012')).toThrow();
    process.env.META_INSTAGRAM_APP_ID = '1683937156688365';
    process.env.META_INSTAGRAM_REDIRECT_URI = 'https://tozon-backend.onrender.com/api/integrations/instagram/callback';
    expect(() => facebookBusinessInstagramAuthorizationUrl('weak')).toThrow();
  });
});
