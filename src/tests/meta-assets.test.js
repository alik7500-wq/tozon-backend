import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverMetaAssets } from '../modules/integrations/meta-assets.client.js';

afterEach(() => { vi.unstubAllEnvs(); });
const response = body => ({ ok: true, json: async () => body });
function fixture(scopes = ['instagram_basic', 'instagram_manage_messages', 'leads_retrieval', 'pages_manage_ads']) {
  vi.stubEnv('META_INSTAGRAM_APP_ID', '1234'); vi.stubEnv('META_INSTAGRAM_APP_SECRET', 'fixture-secret');
  return vi.fn(async (url) => {
    switch (url.pathname) {
      case '/v25.0/debug_token': return response({ data: { is_valid: true, app_id: '1234', scopes, expires_at: 0 } });
      case '/v25.0/me': return response({ id: '15', name: 'Fixture administrator' });
      case '/v25.0/me/accounts': return response({ data: [{ id: '21', name: 'Tower', access_token: 'page-token', instagram_business_account: { id: '31', username: 'tower' } }] });
      case '/v25.0/21/leadgen_forms': return response({ data: [{ id: '41', name: 'Flats', status: 'ACTIVE' }, { id: '42', name: 'Old', status: 'ARCHIVED' }] });
      default: throw new Error('Unexpected fixture URL');
    }
  });
}
describe('verified Meta asset discovery', () => {
  it('discovers multiple source types using granted scopes and actual assets', async () => {
    const catalogue = await discoverMetaAssets('fixture-user-token', fixture());
    expect(catalogue.assets.map(asset => [asset.channel, asset.external_id])).toEqual([
      ['INSTAGRAM_MESSAGES', '31'], ['FACEBOOK_FORM', '41']
    ]);
    expect(catalogue.expiresAt).toBeNull();
  });
  it('never advertises a messaging or form source without the corresponding grants', async () => {
    const request = fixture(['instagram_basic']);
    expect((await discoverMetaAssets('fixture-token', request)).assets).toEqual([]);
    expect(request.mock.calls.some(([url]) => url.pathname.endsWith('/leadgen_forms'))).toBe(false);
  });
  it('rejects a token for another application before discovery', async () => {
    fixture();
    const request = vi.fn(async () => response({ data: { is_valid: true, app_id: '999' } }));
    await expect(discoverMetaAssets('fixture-token', request)).rejects.toThrow('META_TOKEN_INVALID');
    expect(request).toHaveBeenCalledOnce();
  });
  it('respects data access expiry even if the token has no expiry', async () => {
    fixture();
    const request = vi.fn(async () => response({ data: { is_valid: true, app_id: '1234', expires_at: 0, data_access_expires_at: 1 } }));
    await expect(discoverMetaAssets('fixture-token', request)).rejects.toThrow('META_TOKEN_EXPIRED');
  });
  it('paginates using fixed Graph origin instead of following the next URL', async () => {
    const base = fixture();
    const request = vi.fn(async (url, options) => {
      if (url.pathname.endsWith('/me/accounts')) {
        if (url.searchParams.get('after')) return response({ data: [{ id: '22', name: 'Garden', access_token: 'garden-token', instagram_business_account: { id: '32', username: 'garden' } }] });
        return response({ data: [], paging: { next: 'https://untrusted.invalid/token', cursors: { after: 'next-cursor' } } });
      }
      if (url.pathname.endsWith('/22/leadgen_forms')) return response({ data: [] });
      return base(url, options);
    });
    expect((await discoverMetaAssets('fixture-token', request)).assets[0].external_id).toBe('32');
    expect(request.mock.calls.every(([url]) => url.origin === 'https://graph.facebook.com')).toBe(true);
  });
  it('does not leak Meta error messages or tokens through thrown errors', async () => {
    fixture();
    const request = vi.fn(async () => ({ ok: false, json: async () => ({ error: { message: 'fixture-user-token' } }) }));
    await expect(discoverMetaAssets('fixture-user-token', request)).rejects.toThrow(/^META_ASSETS_UNAVAILABLE$/);
  });
});
