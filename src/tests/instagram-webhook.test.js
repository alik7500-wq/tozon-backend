import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
vi.mock('../modules/integrations/instagram-webhook.repository.js', () => ({ persistInstagramWebhookEvent: vi.fn() }));
import { persistInstagramWebhookEvent } from '../modules/integrations/instagram-webhook.repository.js';
import webhookRouter from '../modules/integrations/instagram-webhook.router.js';

const app = express();
app.use('/api/integrations/instagram/webhook', webhookRouter);
const endpoint = '/api/integrations/instagram/webhook';
afterEach(() => {
  delete process.env.META_INSTAGRAM_APP_SECRET;
  delete process.env.META_WEBHOOK_VERIFY_TOKEN;
  delete process.env.INSTAGRAM_INBOX_ACCOUNT_ID;
  vi.resetAllMocks();
});

describe('Instagram Meta webhook safety', () => {
  it('rejects verification when no server verify token is configured', async () => {
    const r = await request(app).get(endpoint).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '123' });
    expect(r.status).toBe(403);
  });

  it('responds to a matching Meta challenge', async () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'verify-local-test';
    const r = await request(app).get(endpoint).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-local-test', 'hub.challenge': '123' });
    expect(r.status).toBe(200);
    expect(r.text).toBe('123');
  });

  it('rejects an invalid webhook signature', async () => {
    process.env.META_INSTAGRAM_APP_SECRET = 'test-secret';
    const r = await request(app).post(endpoint).set('Content-Type', 'application/json').set('X-Hub-Signature-256', 'sha256=' + '0'.repeat(64)).send('{"object":"instagram"}');
    expect(r.status).toBe(403);
  });

  it('acknowledges signed events after durable storage', async () => {
    process.env.META_INSTAGRAM_APP_SECRET = 'test-secret';
    process.env.INSTAGRAM_INBOX_ACCOUNT_ID = '17841447499018452';
    const body = '{"object":"instagram","entry":[]}';
    persistInstagramWebhookEvent.mockResolvedValue({ eventKey: 'saved' });
    const signature = createHmac('sha256', 'test-secret').update(body).digest('hex');
    const r = await request(app).post(endpoint).set('Content-Type', 'application/json').set('X-Hub-Signature-256', 'sha256=' + signature).send(body);
    expect(r.status).toBe(200);
    expect(persistInstagramWebhookEvent).toHaveBeenCalledOnce();
  });
  it('rejects malformed signed JSON without writing to the database', async () => {
    process.env.META_INSTAGRAM_APP_SECRET = 'test-secret';
    process.env.INSTAGRAM_INBOX_ACCOUNT_ID = '17841447499018452';
    const body = '{"object":"instagram",';
    const signature = createHmac('sha256', 'test-secret').update(body).digest('hex');
    const response = await request(app).post(endpoint)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=' + signature).send(body);
    expect(response.status).toBe(400);
    expect(persistInstagramWebhookEvent).not.toHaveBeenCalled();
  });
  it('does not acknowledge events when storage fails', async () => {
    process.env.META_INSTAGRAM_APP_SECRET = 'test-secret';
    process.env.INSTAGRAM_INBOX_ACCOUNT_ID = '17841447499018452';
    persistInstagramWebhookEvent.mockRejectedValue(new Error('offline'));
    const body = '{"object":"instagram","entry":[]}';
    const signature = createHmac('sha256', 'test-secret').update(body).digest('hex');
    const response = await request(app).post(endpoint)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=' + signature).send(body);
    expect(response.status).toBe(503);
  });
});
