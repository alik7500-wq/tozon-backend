import { createHash, randomBytes } from 'node:crypto';

export const createOAuthState = () => {
  const state = randomBytes(32).toString('base64url');
  return { state, digest: digestOAuthState(state) };
};

export const digestOAuthState = (state) => {
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(state)) {
    throw new TypeError('Invalid OAuth state');
  }
  return createHash('sha256').update(state, 'utf8').digest('hex');
};

export const oauthStateExpiry = (now = Date.now()) => new Date(now + 10 * 60 * 1000).toISOString();

// Storage must atomically mark state consumed and check user/session binding;
// this helper intentionally does not provide a process-memory state store.
