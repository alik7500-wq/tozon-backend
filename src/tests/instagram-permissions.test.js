import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectInstagramMessagingPermission } from '../modules/integrations/instagram-permissions.client.js';
describe('Meta permission verification', () => {
  beforeEach(() => {
    process.env.META_INSTAGRAM_APP_ID = '123456789';
    process.env.META_INSTAGRAM_APP_SECRET = 'test-secret';
  });
  it('requires an actual granted messaging permission', async () => {
    const request = vi.fn(async () => ({ ok: true, json: async () => ({ data: { is_valid: true, app_id: '123456789', scopes: ['pages_show_list'] } }) }));
    const result = await inspectInstagramMessagingPermission({ userAccessToken: 'token', request });
    expect(result.messagingAllowed).toBe(false);
    expect(result.grantedScopes).toEqual(['pages_show_list']);
    expect(request.mock.calls[0][1].headers.Authorization).toBe('Bearer 123456789|test-secret');
  });
  it('recognizes verified messaging permission', async () => {
    const request = async () => ({ ok: true, json: async () => ({ data: { is_valid: true, app_id: '123456789', scopes: ['instagram_manage_messages'] } }) });
    expect((await inspectInstagramMessagingPermission({ userAccessToken: 'token', request })).messagingAllowed).toBe(true);
  });
  it('rejects mismatched app identity', async () => {
    const request = async () => ({ ok: true, json: async () => ({ data: { is_valid: true, app_id: '987654321', scopes: ['instagram_manage_messages'] } }) });
    await expect(inspectInstagramMessagingPermission({ userAccessToken: 'token', request })).rejects.toThrow();
  });
  it('rejects invalid tokens and transport errors', async () => {
    const invalid = async () => ({ ok: true, json: async () => ({ data: { is_valid: false, app_id: '123456789' } }) });
    await expect(inspectInstagramMessagingPermission({ userAccessToken: 'token', request: invalid })).rejects.toThrow();
    await expect(inspectInstagramMessagingPermission({ userAccessToken: 'token', request: async () => ({ ok: false }) })).rejects.toThrow();
  });
});
