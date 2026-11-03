import { beforeEach, describe, expect, it, vi } from 'vitest';
const { from, send, decrypt, auth } = vi.hoisted(() => ({
  from: vi.fn(), send: vi.fn(), decrypt: vi.fn(() => 'test-token'),
  auth: { role: 'ADMIN' }
}));
vi.mock('../middleware/auth.middleware.js', () => ({ protect: (req, _res, next) => { req.user = auth; next(); } }));
vi.mock('../db/connection.js', () => ({ getServiceDB: () => ({ from }) }));
vi.mock('../modules/integrations/social-token-crypto.js', () => ({ decryptSocialToken: decrypt }));
vi.mock('../modules/integrations/instagram-message-send.client.js', () => ({ sendInstagramDirectMessage: send }));
import express from 'express';
import request from 'supertest';
import router from '../modules/integrations/instagram-send.router.js';

const app = express();
app.use(express.json());
app.use('/send', router);
const url = '/send/17841447499018452/123456789';
describe('Instagram Direct send route safety', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    auth.role = 'ADMIN';
    process.env.INSTAGRAM_INBOX_ACCOUNT_ID = '17841447499018452';
    delete process.env.INSTAGRAM_INBOX_SEND_ENABLED;
  });
  it('is disabled unless explicitly enabled', async () => {
    expect((await request(app).post(url).send({ text: 'Hello' })).status).toBe(503);
    expect(from).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it('denies non-administrator roles before accessing database', async () => {
    process.env.INSTAGRAM_INBOX_SEND_ENABLED = 'true';
    auth.role = 'MANAGER';
    expect((await request(app).post(url).send({ text: 'Hello' })).status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });
  it('rejects mismatched account and empty message', async () => {
    process.env.INSTAGRAM_INBOX_SEND_ENABLED = 'true';
    expect((await request(app).post('/send/17841447499018453/123456789').send({ text: 'Hello' })).status).toBe(403);
    expect((await request(app).post(url).send({ text: ' ' })).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
  it('refuses sending when connection permission is unverified', async () => {
    process.env.INSTAGRAM_INBOX_SEND_ENABLED = 'true';
    from.mockReturnValue({ select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: [{ encrypted_access_token: 'sealed', granted_scopes: [] }], error: null }) }) }) }) });
    expect((await request(app).post(url).send({ text: 'Hello' })).status).toBe(503);
    expect(send).not.toHaveBeenCalled();
  });
  it('refuses sending when no inbound message is available', async () => {
    process.env.INSTAGRAM_INBOX_SEND_ENABLED = 'true';
    from.mockImplementation(table => table === 'tozon_instagram_connections'
      ? { select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: [{ encrypted_access_token: 'sealed', granted_scopes: ['instagram_manage_messages'] }], error: null }) }) }) }) }
      : { select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) }) }) });
    expect((await request(app).post(url).send({ text: 'Hello' })).status).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });
});
