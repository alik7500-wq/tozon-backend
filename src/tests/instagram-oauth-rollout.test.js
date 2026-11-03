import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  protect: (_req, _res, next) => { _req.user = { id: 1, role: 'ADMIN' }; next(); },
  saveState: vi.fn(),
  consumeState: vi.fn(),
  exchange: vi.fn(),
  extend: vi.fn(),
  resolve: vi.fn(),
  inspect: vi.fn(),
  saveConnection: vi.fn(),
  status: vi.fn()
}));
vi.mock('../middleware/auth.middleware.js', () => ({ protect: mocks.protect }));
vi.mock('../modules/integrations/instagram-oauth.repository.js', () => ({
  saveInstagramOAuthState: mocks.saveState, consumeInstagramOAuthState: mocks.consumeState
}));
vi.mock('../modules/integrations/facebook-business-token.client.js', () => ({
  exchangeFacebookBusinessCode: mocks.exchange, extendFacebookBusinessToken: mocks.extend,
  resolveTozonInstagramAccount: mocks.resolve
}));
vi.mock('../modules/integrations/instagram-permissions.client.js', () => ({
  inspectInstagramMessagingPermission: mocks.inspect
}));
vi.mock('../modules/integrations/instagram-connection.repository.js', () => ({
  saveTozonInstagramConnection: mocks.saveConnection, getTozonInstagramConnectionStatus: mocks.status
}));
import router from '../modules/integrations/instagram.router.js';
const app = express();
app.use('/instagram', router);
const validState = '12345678901234567890123456789012';
afterEach(() => {
  delete process.env.INSTAGRAM_OAUTH_ENABLED;
  delete process.env.META_INSTAGRAM_APP_ID;
  delete process.env.META_INSTAGRAM_REDIRECT_URI;
  vi.clearAllMocks();
});
describe('Instagram OAuth rollout and permissions', () => {
  it('does not allow connecting while rollout is disabled', async () => {
    const response = await request(app).post('/instagram/connect');
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('INSTAGRAM_OAUTH_DISABLED');
    expect(mocks.saveState).not.toHaveBeenCalled();
  });
  it('does not exchange callback codes while rollout is disabled', async () => {
    const response = await request(app).get('/instagram/callback').query({ code: 'abc', state: validState });
    expect(response.status).toBe(503);
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it('rejects missing or reused state without token exchange', async () => {
    process.env.INSTAGRAM_OAUTH_ENABLED = 'true';
    mocks.consumeState.mockResolvedValue(null);
    const response = await request(app).get('/instagram/callback').query({ code: 'abc', state: validState });
    expect(response.status).toBe(403);
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it('rejects connection when messaging permission is not granted', async () => {
    process.env.INSTAGRAM_OAUTH_ENABLED = 'true';
    mocks.consumeState.mockResolvedValue({ userId: '1' });
    mocks.exchange.mockResolvedValue({ accessToken: 'short' });
    mocks.extend.mockResolvedValue({ accessToken: 'long' });
    mocks.resolve.mockResolvedValue({ instagramUserId: '17841447499018452', pageAccessToken: 'page' });
    mocks.inspect.mockResolvedValue({ grantedScopes: [], messagingAllowed: false });
    const response = await request(app).get('/instagram/callback').query({ code: 'abc', state: validState });
    expect(response.status).toBe(403);
    expect(mocks.saveConnection).not.toHaveBeenCalled();
  });
  it('saves the connection only after verified messaging permission', async () => {
    process.env.INSTAGRAM_OAUTH_ENABLED = 'true';
    mocks.consumeState.mockResolvedValue({ userId: '1' });
    mocks.exchange.mockResolvedValue({ accessToken: 'short' });
    mocks.extend.mockResolvedValue({ accessToken: 'long' });
    mocks.resolve.mockResolvedValue({ instagramUserId: '17841447499018452', pageAccessToken: 'page' });
    mocks.inspect.mockResolvedValue({ grantedScopes: ['instagram_manage_messages'], messagingAllowed: true });
    mocks.saveConnection.mockResolvedValue({});
    const response = await request(app).get('/instagram/callback').query({ code: 'abc', state: validState });
    expect(response.status).toBe(200);
    expect(mocks.saveConnection).toHaveBeenCalledOnce();
  });
});
