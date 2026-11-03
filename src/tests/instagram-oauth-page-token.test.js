import { beforeEach, describe, expect, it, vi } from 'vitest';
const { inspect, save, resolve, consume, exchange, extend } = vi.hoisted(() => ({
  inspect: vi.fn(), save: vi.fn(), resolve: vi.fn(), consume: vi.fn(),
  exchange: vi.fn(), extend: vi.fn()
}));
vi.mock('../middleware/auth.middleware.js', () => ({ protect: (_req, _res, next) => next() }));
vi.mock('../modules/integrations/social-oauth-state.js', () => ({ createOAuthState: () => ({ state: 'a'.repeat(32) }) }));
vi.mock('../modules/integrations/instagram-oauth.repository.js', () => ({
  saveInstagramOAuthState: vi.fn(), consumeInstagramOAuthState: consume
}));
vi.mock('../modules/integrations/facebook-business-instagram-oauth.js', () => ({
  facebookBusinessInstagramAuthorizationUrl: () => 'https://www.facebook.com/dialog/oauth'
}));
vi.mock('../modules/integrations/facebook-business-token.client.js', () => ({
  exchangeFacebookBusinessCode: exchange, extendFacebookBusinessToken: extend, resolveTozonInstagramAccount: resolve
}));
vi.mock('../modules/integrations/instagram-permissions.client.js', () => ({ inspectInstagramMessagingPermission: inspect }));
vi.mock('../modules/integrations/instagram-connection.repository.js', () => ({
  saveTozonInstagramConnection: save, getTozonInstagramConnectionStatus: vi.fn()
}));
import express from 'express';
import request from 'supertest';
import router from '../modules/integrations/instagram.router.js';
const app = express();
app.use('/instagram', router);
describe('Instagram OAuth token scoping', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    consume.mockResolvedValue({ userId: 1 });
    exchange.mockResolvedValue({ accessToken: 'short-user-token' });
    extend.mockResolvedValue({ accessToken: 'long-user-token' });
    resolve.mockResolvedValue({ instagramUserId: '17841447499018452', pageAccessToken: 'actual-page-token' });
    inspect.mockResolvedValue({ grantedScopes: ['instagram_manage_messages'] });
    save.mockResolvedValue({});
  });
  it('inspects the actual Page token before saving the connection', async () => {
    const response = await request(app).get('/instagram/callback?code=valid&state=valid');
    expect(response.status).toBe(200);
    expect(inspect).toHaveBeenCalledWith({ userAccessToken: 'actual-page-token' });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'actual-page-token', grantedScopes: ['instagram_manage_messages']
    }));
  });
  it('does not persist a connection when Page token verification fails', async () => {
    inspect.mockRejectedValue(new Error('invalid token'));
    expect((await request(app).get('/instagram/callback?code=valid&state=valid')).status).toBe(503);
    expect(save).not.toHaveBeenCalled();
  });
});
