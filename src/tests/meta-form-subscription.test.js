import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeMetaLeadgen } from '../modules/integrations/meta-form-subscription.client.js';
afterEach(() => vi.unstubAllEnvs());
const response = body => ({ ok: true, json: async () => body });
describe('Facebook form subscription verification', () => {
  it('preserves existing app fields and confirms leadgen after subscribing', async () => {
    vi.stubEnv('META_INSTAGRAM_APP_ID', '123');
    let reads = 0;
    const request = vi.fn(async (_url, options) => {
      if (options.method === 'POST') {
        expect(options.body.get('subscribed_fields')).toBe('messages,feed,leadgen');
        expect(options.headers.Authorization).toBe('Bearer fixture-token');
        return response({ success: true });
      }
      return response({ data: [{ id: '123', subscribed_fields: ++reads === 1 ? ['messages','feed'] : ['messages','feed','leadgen'] }] });
    });
    expect(await subscribeMetaLeadgen('21', 'fixture-token', request)).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('does not resubscribe when leadgen is already present', async () => {
    vi.stubEnv('META_INSTAGRAM_APP_ID', '123');
    const request = vi.fn(async () => response({ data: [{ id: '123', subscribed_fields: ['leadgen'] }] }));
    expect(await subscribeMetaLeadgen('21', 'fixture-token', request)).toBe(true);
    expect(request.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false);
  });
  it('does not claim success from a POST alone', async () => {
    vi.stubEnv('META_INSTAGRAM_APP_ID', '123');
    const request = vi.fn(async (_url, options) => options.method === 'POST' ? response({ success: true }) : response({ data: [] }));
    await expect(subscribeMetaLeadgen('21', 'fixture-token', request)).rejects.toThrow('META_SUBSCRIPTION_NOT_CONFIRMED');
  });
  it('does not overwrite fields after an incomplete catalogue read', async () => {
    vi.stubEnv('META_INSTAGRAM_APP_ID', '123');
    const request = vi.fn(async () => response({ data: [], paging: { next: 'https://untrusted.invalid' } }));
    await expect(subscribeMetaLeadgen('21', 'fixture-token', request)).rejects.toThrow('META_SUBSCRIPTION_INCOMPLETE');
    expect(request).toHaveBeenCalledOnce();
  });
});
