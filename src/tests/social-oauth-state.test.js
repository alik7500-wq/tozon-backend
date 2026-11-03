import { describe, expect, it } from 'vitest';
import { createOAuthState, digestOAuthState, oauthStateExpiry } from '../modules/integrations/social-oauth-state.js';

describe('social OAuth state', () => {
  it('creates unpredictable distinct states and hashes', () => {
    const a = createOAuthState();
    const b = createOAuthState();
    expect(a.state).not.toBe(b.state);
    expect(a.digest).toBe(digestOAuthState(a.state));
    expect(a.digest).not.toBe(a.state);
    expect(a.digest).toHaveLength(64);
  });

  it('rejects malformed state before database lookup', () => {
    expect(() => digestOAuthState('abc')).toThrow();
    expect(() => digestOAuthState('x'.repeat(500))).toThrow();
  });

  it('expires states after ten minutes', () => {
    expect(oauthStateExpiry(0)).toBe(new Date(600000).toISOString());
  });
});
