import { afterEach, describe, expect, it } from 'vitest';
import { decryptSocialToken, encryptSocialToken } from '../modules/integrations/social-token-crypto.js';

const previous = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;
afterEach(() => {
  if (previous === undefined) delete process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;
  else process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = previous;
});

describe('social access token encryption', () => {
  it('round trips a token without storing plaintext', () => {
    process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    const token = 'instagram-test-token';
    const sealed = encryptSocialToken(token);
    expect(sealed).not.toContain(token);
    expect(decryptSocialToken(sealed)).toBe(token);
  });

  it('uses a fresh random nonce on each encryption', () => {
    process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    expect(encryptSocialToken('same')).not.toBe(encryptSocialToken('same'));
  });

  it('rejects altered encrypted payloads', () => {
    process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    const sealed = encryptSocialToken('secret');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered', 'utf8').toString('base64url');
    expect(() => decryptSocialToken(parts.join('.'))).toThrow();
  });

  it('fails closed when the encryption key is absent', () => {
    delete process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;
    expect(() => encryptSocialToken('secret')).toThrow(/SOCIAL_TOKEN_ENCRYPTION_KEY/);
  });
});
