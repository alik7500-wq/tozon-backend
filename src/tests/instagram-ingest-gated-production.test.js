import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';

const upsert = vi.fn();
vi.mock('../db/connection.js', () => ({ getServiceDB: () => ({ from: () => ({ upsert }) }) }));
import webhookRouter from '../modules/integrations/instagram-ingest-gated.router.js';

const app = express();
app.use('/api/integrations/instagram/webhook', webhookRouter);
app.use(express.json());
const url = '/api/integrations/instagram/webhook';
const body = JSON.stringify({ object: 'instagram', entry: [{ id: '17841447499018452', messaging: [] }] });
const sign = value => 'sha256=' + createHmac('sha256', 'unit-test-secret').update(value).digest('hex');
const post = (value, signature = sign(value)) => request(app).post(url)
  .set('Content-Type', 'application/json').set('X-Hub-Signature-256', signature).send(value);

afterEach(() => {
  for (const key of ['INSTAGRAM_WEBHOOK_INGEST_ENABLED', 'INSTAGRAM_INBOX_ACCOUNT_ID', 'META_INSTAGRAM_APP_SECRET']) delete process.env[key];
  upsert.mockReset();
});
function enable() {
  process.env.INSTAGRAM_WEBHOOK_INGEST_ENABLED = 'true';
  process.env.INSTAGRAM_INBOX_ACCOUNT_ID = '17841447499018452';
  process.env.META_INSTAGRAM_APP_SECRET = 'unit-test-secret';
}
describe('isolated Instagram webhook ingestion', () => {
  it('remains disabled by default without database writes', async () => {
    expect((await post(body)).status).toBe(503);
    expect(upsert).not.toHaveBeenCalled();
  });
  it('rejects incorrect signatures', async () => {
    enable();
    expect((await post(body, 'sha256=' + '0'.repeat(64))).status).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
  });
  it('rejects events for a different Instagram account', async () => {
    enable();
    const other = JSON.stringify({ object: 'instagram', entry: [{ id: '99999999999' }] });
    expect((await post(other)).status).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
  });
  it('persists correctly signed events once and acknowledges only after storage', async () => {
    enable();
    upsert.mockResolvedValue({ error: null });
    expect((await post(body)).status).toBe(200);
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert.mock.calls[0][1]).toEqual({ onConflict: 'event_key', ignoreDuplicates: true });
  });
  it('returns 503 if durable storage fails', async () => {
    enable();
    upsert.mockResolvedValue({ error: { message: 'offline' } });
    expect((await post(body)).status).toBe(503);
  });
  it('rejects malformed signed JSON', async () => {
    enable();
    const invalid = '{"object":';
    expect((await post(invalid)).status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });
});
