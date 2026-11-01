import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = {
  insert: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  is: vi.fn(),
  gt: vi.fn(),
  select: vi.fn(),
  maybeSingle: vi.fn()
};
query.insert.mockResolvedValue({ error: null });
query.update.mockReturnValue(query);
query.eq.mockReturnValue(query);
query.is.mockReturnValue(query);
query.gt.mockReturnValue(query);
query.select.mockReturnValue(query);

vi.mock('../db/connection.js', () => ({
  getServiceDB: () => ({ from: () => query })
}));

import { saveInstagramOAuthState, consumeInstagramOAuthState } from '../modules/integrations/instagram-oauth.repository.js';
import { createOAuthState } from '../modules/integrations/social-oauth-state.js';

beforeEach(() => {
  vi.clearAllMocks();
  query.insert.mockResolvedValue({ error: null });
  query.update.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.is.mockReturnValue(query);
  query.gt.mockReturnValue(query);
  query.select.mockReturnValue(query);
});

describe('Instagram OAuth state repository', () => {
  it('stores only a digest and user ID', async () => {
    const { state, digest } = createOAuthState();
    await saveInstagramOAuthState({ state, userId: 12 });
    expect(query.insert).toHaveBeenCalledWith(expect.objectContaining({
      state_digest: digest,
      initiated_by: '12'
    }));
    expect(JSON.stringify(query.insert.mock.calls)).not.toContain(state);
  });

  it('consumes an unexpired unused state with an atomic conditional update', async () => {
    query.maybeSingle.mockResolvedValue({ data: { initiated_by: '12' }, error: null });
    const { state, digest } = createOAuthState();
    await expect(consumeInstagramOAuthState({ state })).resolves.toEqual({ userId: '12' });
    expect(query.eq).toHaveBeenCalledWith('state_digest', digest);
    expect(query.is).toHaveBeenCalledWith('consumed_at', null);
    expect(query.gt).toHaveBeenCalledWith('expires_at', expect.any(String));
  });

  it('rejects missing or already consumed state', async () => {
    query.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(consumeInstagramOAuthState({ state: createOAuthState().state })).resolves.toBeNull();
  });
});
