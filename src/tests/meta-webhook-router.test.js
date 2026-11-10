import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
const { enqueue } = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock('../modules/integrations/meta-events.repository.js', () => ({ MetaEvents: { enqueue } }));
import router from '../modules/integrations/meta-webhook.router.js';
const app = express(); app.use('/meta/webhook', router); app.use(express.json());
const body = JSON.stringify({ object: 'page', entry: [{ id: '21', changes: [{ field: 'leadgen', value: { page_id: '21', form_id: '41', leadgen_id: '101' } }] }] });
const signature = body => 'sha256=' + createHmac('sha256', 'fixture-secret').update(body).digest('hex');
const send = (payload = body, sig = signature(payload)) => request(app).post('/meta/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sig).send(payload);
beforeEach(() => {
  vi.stubEnv('META_SOURCE_ROUTING_ENABLED', 'true'); vi.stubEnv('META_SOURCE_INGEST_ENABLED', 'true'); vi.stubEnv('META_INSTAGRAM_APP_SECRET', 'fixture-secret');
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('signed Meta webhook intake', () => {
  it('fails closed while ingestion is disabled', async () => {
    vi.stubEnv('META_SOURCE_INGEST_ENABLED', 'false'); expect((await send()).status).toBe(503); expect(enqueue).not.toHaveBeenCalled();
  });
  it('rejects missing/incorrect signatures without storage', async () => {
    expect((await send(body, 'sha256=' + '0'.repeat(64))).status).toBe(403); expect(enqueue).not.toHaveBeenCalled();
  });
  it('verifies the original bytes rather than a reserialized payload', async () => {
    enqueue.mockResolvedValue(1);
    const spaced = body.replace('{', '{ ');
    expect((await send(spaced, signature(body))).status).toBe(403);
    expect((await send(spaced)).status).toBe(200);
    expect(enqueue.mock.calls[0][0][0].external_id).toBe('41');
  });
  it('acknowledges only durable storage and returns retryable failure when storage is down', async () => {
    enqueue.mockRejectedValue(new Error('fixture storage failure'));
    const failed = await send(); expect(failed.status).toBe(503); expect(failed.text).not.toContain('fixture storage failure');
    enqueue.mockResolvedValue(0); expect((await send()).status).toBe(200);
  });
  it('rejects malformed signed JSON', async () => { expect((await send('{')).status).toBe(400); expect(enqueue).not.toHaveBeenCalled(); });
  it('answers verification challenges without exposing the verify token', async () => {
    vi.stubEnv('META_SOURCES_WEBHOOK_VERIFY_TOKEN', 'fixture-verification');
    const query = { 'hub.mode': 'subscribe', 'hub.verify_token': 'fixture-verification', 'hub.challenge': 'fixture-challenge' };
    const response = await request(app).get('/meta/webhook').query(query); expect(response.status).toBe(200); expect(response.text).toBe('fixture-challenge');
    query['hub.verify_token'] = 'wrong'; expect((await request(app).get('/meta/webhook').query(query)).status).toBe(403);
  });
});
