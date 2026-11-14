import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
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
  status: vi.fn(), active: vi.fn(async()=>true), subscribe: vi.fn(async()=>{}), disconnect: vi.fn(), credentials: vi.fn()
}));
vi.mock('../middleware/auth.middleware.js', () => ({ protect: mocks.protect }));
vi.mock('../modules/integrations/instagram-oauth.repository.js', () => ({
  saveInstagramOAuthState: mocks.saveState, consumeInstagramOAuthState: mocks.consumeState
}));
vi.mock('../modules/integrations/facebook-business-token.client.js', () => ({
  exchangeFacebookBusinessCode: mocks.exchange, extendFacebookBusinessToken: mocks.extend,
  resolveInstagramAccounts: mocks.resolve, setInstagramWebhookSubscription: mocks.subscribe
}));
vi.mock('../modules/integrations/instagram-permissions.client.js', () => ({
  inspectInstagramMessagingPermission: mocks.inspect
}));
vi.mock('../modules/integrations/instagram-connection.repository.js', () => ({
  saveInstagramConnections: mocks.saveConnection, getTozonInstagramConnectionStatus: mocks.status,
  getInstagramInboxCredentials:mocks.credentials, disconnectInstagramAccount:mocks.disconnect, validInstagramAccountId:id=>/^\d{5,40}$/.test(id), isInstagramOAuthActorActive:mocks.active
}));
import router from '../modules/integrations/instagram.router.js';
const app = express();
app.use('/instagram', router);
const validState = '12345678901234567890123456789012';
beforeEach(()=>mocks.active.mockResolvedValue(true));
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
    mocks.resolve.mockResolvedValue([{ instagramUserId: '17841447499018452', username:'tozon_plaza', pageAccessToken: 'page' }]);
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
    mocks.resolve.mockResolvedValue([{ instagramUserId: '17841447499018452', username:'tozon_plaza', pageAccessToken: 'page' }]);
    mocks.inspect.mockResolvedValue({ grantedScopes: ['instagram_manage_messages'], messagingAllowed: true });
    mocks.saveConnection.mockResolvedValue({});
    const response = await request(app).get('/instagram/callback').query({ code: 'abc', state: validState });
    expect(response.status).toBe(200);
    expect(mocks.saveConnection).toHaveBeenCalledOnce();
  });
  it('saves multiple authorized profiles together and subscribes each independently',async()=>{
    process.env.INSTAGRAM_OAUTH_ENABLED='true';mocks.consumeState.mockResolvedValue({userId:'1'});
    mocks.exchange.mockResolvedValue({accessToken:'short'});mocks.extend.mockResolvedValue({accessToken:'long'});
    mocks.resolve.mockResolvedValue([{instagramUserId:'11111',username:'first',pageAccessToken:'one'},{instagramUserId:'22222',username:'second',pageAccessToken:'two'}]);
    mocks.inspect.mockResolvedValue({messagingAllowed:true,grantedScopes:['instagram_manage_messages']});
    expect((await request(app).get('/instagram/callback').query({code:'abc',state:validState})).status).toBe(200);
    expect(mocks.saveConnection).toHaveBeenCalledTimes(1);expect(mocks.saveConnection.mock.calls[0][0].map(a=>a.instagramUserId)).toEqual(['11111','22222']);
    expect(mocks.subscribe).toHaveBeenCalledWith({accountId:'11111',token:'one'});expect(mocks.subscribe).toHaveBeenCalledWith({accountId:'22222',token:'two'});
  });
  it('refuses a callback after its administrator loses access',async()=>{
    process.env.INSTAGRAM_OAUTH_ENABLED='true';mocks.consumeState.mockResolvedValue({userId:'1'});mocks.active.mockResolvedValue(false);
    expect((await request(app).get('/instagram/callback').query({code:'abc',state:validState})).status).toBe(403);
    expect(mocks.exchange).not.toHaveBeenCalled();expect(mocks.saveConnection).not.toHaveBeenCalled();
  });
  it('saves no profiles if any selected profile lacks messaging permission',async()=>{
    process.env.INSTAGRAM_OAUTH_ENABLED='true';mocks.consumeState.mockResolvedValue({userId:'1'});
    mocks.resolve.mockResolvedValue([{instagramUserId:'11111',pageAccessToken:'one'},{instagramUserId:'22222',pageAccessToken:'two'}]);
    mocks.inspect.mockImplementation(async ({userAccessToken})=>({messagingAllowed:userAccessToken==='one',grantedScopes:[]}));
    expect((await request(app).get('/instagram/callback').query({code:'abc',state:validState})).status).toBe(403);
    expect(mocks.saveConnection).not.toHaveBeenCalled();expect(mocks.subscribe).not.toHaveBeenCalled();
  });
  it('disconnects and unsubscribes only the requested account',async()=>{
    mocks.credentials.mockResolvedValue({accountId:'22222',token:'two'});mocks.disconnect.mockResolvedValue(true);
    expect((await request(app).post('/instagram/accounts/22222/disconnect')).status).toBe(200);
    expect(mocks.disconnect).toHaveBeenCalledWith('22222');
    expect(mocks.subscribe).toHaveBeenCalledWith({accountId:'22222',token:'two',disconnect:true});
  });
});
