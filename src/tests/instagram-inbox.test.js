import { describe, expect, it, vi, beforeEach } from 'vitest';
const { protect, from } = vi.hoisted(() => ({ protect: vi.fn((req, res, next) => { req.user = { role: 'ADMIN' }; next(); }), from: vi.fn() }));
vi.mock('../middleware/auth.middleware.js', () => ({ protect }));
vi.mock('../db/connection.js', () => ({ getServiceDB: () => ({ from }) }));
import express from 'express';
import request from 'supertest';
import router from '../modules/integrations/instagram-inbox.router.js';
const app = express();
app.use('/inbox', router);
describe('Instagram inbox', () => {
  beforeEach(() => vi.resetAllMocks());
  it('returns grouped conversations without raw webhook payload', async () => {
    const limit = vi.fn().mockResolvedValue({ data: [{ instagram_account_id: 'business', sender_id: 'customer', recipient_id: 'business', text_content: 'Hello', is_echo: false, received_at: '2026-11-02T00:00:00Z' }], error: null });
    from.mockReturnValue({ select: () => ({ order: () => ({ limit }) }) });
    const response = await request(app).get('/inbox/conversations');
    expect(response.status).toBe(200);
    expect(response.body.data[0].contactId).toBe('customer');
  });
  it('fails closed when database is unavailable', async () => {
    from.mockReturnValue({ select: () => ({ order: () => ({ limit: vi.fn().mockResolvedValue({ error: { message: 'offline' } }) }) }) });
    const response = await request(app).get('/inbox/conversations');
    expect(response.status).toBe(503);
  });
  it('rejects invalid account and contact IDs', async () => {
    const response = await request(app).get('/inbox/conversations/invalid/12345/messages');
    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });
  it('returns conversation messages scoped to the requested account and contact', async () => {
    const limit = vi.fn().mockResolvedValue({ data: [{ message_id: 'm1', text_content: 'Hi' }], error: null });
    const order = vi.fn().mockReturnValue({ limit });
    const or = vi.fn().mockReturnValue({ order });
    const eq = vi.fn().mockReturnValue({ or });
    from.mockReturnValue({ select: () => ({ eq }) });
    const response = await request(app).get('/inbox/conversations/17841447499018452/123456789/messages');
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(eq).toHaveBeenCalledWith('instagram_account_id', '17841447499018452');
    expect(or).toHaveBeenCalledWith('sender_id.eq.123456789,recipient_id.eq.123456789');
  });

});
