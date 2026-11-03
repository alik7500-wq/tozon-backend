import { describe, expect, it, vi } from 'vitest';
vi.mock('../db/connection.js', () => ({ getServiceDB: vi.fn() }));
import { getServiceDB } from '../db/connection.js';
import { webhookEventKey, persistInstagramWebhookEvent } from '../modules/integrations/instagram-webhook.repository.js';
describe('Instagram webhook durable storage', () => {
  it('creates deterministic keys for identical retry payloads', () => {
    const event = { object: 'instagram', entry: [{ id: '17841447499018452' }] };
    expect(webhookEventKey(event)).toBe(webhookEventKey(event));
    expect(webhookEventKey(event)).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects invalid payloads', () => {
    expect(() => webhookEventKey(null)).toThrow();
    expect(() => webhookEventKey([])).toThrow();
  });
  it('uses database unique constraint to ignore retries', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    getServiceDB.mockReturnValue({ from: () => ({ upsert }) });
    await persistInstagramWebhookEvent({ object: 'instagram' });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ event_key: expect.any(String) }), { onConflict: 'event_key', ignoreDuplicates: true });
  });
  it('fails closed when storage is unavailable', async () => {
    getServiceDB.mockReturnValue({ from: () => ({ upsert: async () => ({ error: { message: 'offline' } }) }) });
    await expect(persistInstagramWebhookEvent({ object: 'instagram' })).rejects.toThrow('Failed to durably store');
  });
});
