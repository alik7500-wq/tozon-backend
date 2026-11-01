import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import webhookRouter from '../modules/integrations/instagram-webhook.router.js';

const app = express();
app.use('/api/integrations/instagram/webhook', webhookRouter);
const endpoint = '/api/integrations/instagram/webhook';
afterEach(() => {
  delete process.env.META_APP_SECRET;
  delete process.env.META_WEBHOOK_VERIFY_TOKEN;
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
    process.env.META_APP_SECRET = 'test-secret';
    const r = await request(app).post(endpoint).set('Content-Type', 'application/json').set('X-Hub-Signature-256', 'sha256=' + '0'.repeat(64)).send('{"object":"instagram"}');
    expect(r.status).toBe(403);
  });

  it('does not acknowledge signed events before durable processing exists', async () => {
    process.env.META_APP_SECRET = 'test-secret';
    const body = '{"object":"instagram"}';
    const signature = createHmac('sha256', 'test-secret').update(body).digest('hex');
    const r = await request(app).post(endpoint).set('Content-Type', 'application/json').set('X-Hub-Signature-256', 'sha256=' + signature).send(body);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('INSTAGRAM_WEBHOOK_PROCESSOR_NOT_READY');
  });
});
