import { describe, expect, it, vi } from 'vitest';
import { sendInstagramDirectMessage } from '../modules/integrations/instagram-message-send.client.js';

describe('Instagram Direct outbound API client', () => {
  it('sends only a scoped response and returns Meta message id', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message_id: 'mid.123' }) });
    expect(await sendInstagramDirectMessage({ pageAccessToken: 'secret', recipientId: '123456789', text: ' Привет ', request })).toEqual({ messageId: 'mid.123' });
    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0];
    expect(url).toMatch(/^https:\/\/graph\.facebook\.com\/v25\.0\/me\/messages$/);
    expect(options.headers.Authorization).toBe('Bearer secret');
    expect(JSON.parse(options.body)).toEqual({ recipient: { id: '123456789' }, messaging_type: 'RESPONSE', message: { text: 'Привет' } });
  });
  it('rejects invalid recipients before contacting Meta', async () => {
    const request = vi.fn();
    await expect(sendInstagramDirectMessage({ pageAccessToken: 'secret', recipientId: '123,456', text: 'Hello', request })).rejects.toThrow(TypeError);
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects empty and oversized messages', async () => {
    const request = vi.fn();
    for (const text of [' ', 'x'.repeat(1001)]) {
      await expect(sendInstagramDirectMessage({ pageAccessToken: 'secret', recipientId: '123456789', text, request })).rejects.toThrow(TypeError);
    }
    expect(request).not.toHaveBeenCalled();
  });
  it('does not expose Meta errors or tokens', async () => {
    const request = vi.fn().mockResolvedValue({ ok: false });
    await expect(sendInstagramDirectMessage({ pageAccessToken: 'secret', recipientId: '123456789', text: 'Hello', request })).rejects.toThrow('Instagram message delivery failed');
  });
});
