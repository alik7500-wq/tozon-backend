import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkMetaCredentials } from '../modules/integrations/meta-credentials.client.js';
afterEach(() => vi.unstubAllEnvs());
describe('private app credential diagnostics', () => {
  const setup = () => { vi.stubEnv('META_INSTAGRAM_APP_ID', '123'); vi.stubEnv('META_INSTAGRAM_APP_SECRET', 'fixture-secret'); };
  it('returns success without disclosing the app token or secret', async () => {
    setup(); const result = await checkMetaCredentials(async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'fixture-app-token' }) }));
    expect(result).toEqual({ accepted: true, diagnostic: 'APP_CREDENTIALS_ACCEPTED', httpStatus: 200, metaCode: null });
    expect(JSON.stringify(result)).not.toContain('fixture');
  });
  it('classifies the known Meta reply without exposing free-form messages', async () => {
    setup(); const result = await checkMetaCredentials(async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 1, message: 'Error validating client secret. fixture-secret' } }) }));
    expect(result).toMatchObject({ accepted: false, diagnostic: 'META_CANNOT_VALIDATE_CLIENT_SECRET', metaCode: 1 });
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });
  it('does not call Meta with missing configuration', async () => {
    vi.stubEnv('META_INSTAGRAM_APP_SECRET', ''); const request = vi.fn();
    expect((await checkMetaCredentials(request)).diagnostic).toBe('CONFIGURATION_MISSING'); expect(request).not.toHaveBeenCalled();
  });
  it('distinguishes network failure from rejected credentials', async () => {
    setup(); const result = await checkMetaCredentials(async () => { throw new Error('fixture-secret'); });
    expect(result.diagnostic).toBe('NETWORK_OR_UNREADABLE_RESPONSE');
  });
});
