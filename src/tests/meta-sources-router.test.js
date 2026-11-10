import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
const mocks = vi.hoisted(() => ({
  user: { id: 1, role: 'ADMIN', is_active: true },
  list: vi.fn(), bind: vi.fn(), disconnect: vi.fn(), saveState: vi.fn(), consumeState: vi.fn(), sync: vi.fn(),
  findUser: vi.fn(), discover: vi.fn(), events: vi.fn(), assign: vi.fn()
}));
vi.mock('../middleware/auth.middleware.js', () => ({ protect: (req, _res, next) => { req.user = mocks.user; next(); } }));
vi.mock('../middleware/sectionAccess.js', () => ({
  isMatrixUser: user => user.permissions?.includes('access.v2'),
  hasSection: user => user.permissions?.includes('automation.view') && user.permissions?.includes('automation.manage')
}));
vi.mock('../modules/users/users.repository.js', () => ({ UsersRepository: { findById: mocks.findUser } }));
vi.mock('../modules/integrations/meta-sources.repository.js', () => ({ MetaSources: mocks }));
vi.mock('../modules/integrations/meta-events.repository.js', () => ({ MetaEvents: { list: mocks.events, assign: mocks.assign } }));
vi.mock('../modules/integrations/meta-assets.client.js', () => ({ discoverMetaAssets: mocks.discover }));
import router from '../modules/integrations/meta-sources.router.js';
const app = express(); app.use(express.json()); app.use('/meta', router);
const state = 's'.repeat(43);
const sourceId = '12345678-1234-1234-1234-123456789abc';
beforeEach(() => {
  mocks.user = { id: 1, role: 'ADMIN', is_active: true };
  vi.stubEnv('META_SOURCE_ROUTING_ENABLED', 'true');
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('Meta settings authorization and OAuth', () => {
  it('does not query storage before rollout is enabled', async () => {
    vi.stubEnv('META_SOURCE_ROUTING_ENABLED', 'false');
    expect((await request(app).get('/meta/sources')).body.data.enabled).toBe(false);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it.each(['MANAGER', 'FINANCE_MANAGER', 'WAREHOUSE_MANAGER'])('rejects %s without exposing sources', async role => {
    mocks.user = { id: 2, role, is_active: true };
    expect((await request(app).get('/meta/sources')).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('respects restricted administrator section permissions', async () => {
    mocks.user = { id: 1, role: 'ADMIN', is_active: true, permissions: ['access.v2', 'automation.view'] };
    expect((await request(app).get('/meta/sources')).status).toBe(403);
  });
  it('uses the authenticated administrator rather than a browser-supplied owner', async () => {
    mocks.bind.mockResolvedValue(true);
    expect((await request(app).patch(`/meta/sources/${sourceId}`).send({ projectId: '11', ownerId: '2' })).status).toBe(200);
    expect(mocks.bind).toHaveBeenCalledWith(1, sourceId, '11');
  });
  it.each([undefined, 11, 'ALL', '0', '-1', '1.2', '9223372036854775808'])('rejects invalid project identifier %s', async projectId => {
    expect((await request(app).patch(`/meta/sources/${sourceId}`).send({ projectId })).status).toBe(400);
    expect(mocks.bind).not.toHaveBeenCalled();
  });
  it('allows explicitly unassigning a source', async () => {
    mocks.bind.mockResolvedValue(true);
    expect((await request(app).patch(`/meta/sources/${sourceId}`).send({ projectId: null })).status).toBe(200);
    expect(mocks.bind).toHaveBeenCalledWith(1, sourceId, null);
  });
  it('returns not found for unavailable or foreign sources', async () => {
    mocks.bind.mockResolvedValue(false);
    expect((await request(app).patch(`/meta/sources/${sourceId}`).send({ projectId: '11' })).status).toBe(404);
  });
  it('creates an authorization URL with a persisted state and separate callback', async () => {
    vi.stubEnv('META_INSTAGRAM_APP_ID', '123'); vi.stubEnv('META_INSTAGRAM_APP_SECRET', 'fixture-secret');
    vi.stubEnv('META_SOURCES_CONFIG_ID', '456'); vi.stubEnv('META_SOURCES_REDIRECT_URI', 'https://api.example.test/api/integrations/meta/callback');
    const result = await request(app).post('/meta/connect');
    expect(result.status).toBe(200);
    const url = new URL(result.body.data.authorizationUrl);
    expect(url.searchParams.get('config_id')).toBe('456');
    expect(url.searchParams.get('client_secret')).toBeNull();
    expect(mocks.saveState).toHaveBeenCalledWith(url.searchParams.get('state'), 1);
  });
  it('rejects reused callback state before any token exchange', async () => {
    mocks.consumeState.mockResolvedValue(null);
    const result = await request(app).get('/meta/callback').query({ state, code: 'fixture' });
    expect(result.status).toBe(403);
    expect(mocks.discover).not.toHaveBeenCalled();
  });
  it('rechecks administrator access when returning from Meta', async () => {
    mocks.consumeState.mockResolvedValue({ owner_user_id: '1' });
    mocks.findUser.mockResolvedValue({ id: 1, role: 'MANAGER', is_active: true });
    expect((await request(app).get('/meta/callback').query({ state, code: 'fixture' })).status).toBe(403);
    expect(mocks.sync).not.toHaveBeenCalled();
  });
  it('consumes state on cancellation without saving a connection', async () => {
    mocks.consumeState.mockResolvedValue({ owner_user_id: '1' }); mocks.findUser.mockResolvedValue(mocks.user);
    expect((await request(app).get('/meta/callback').query({ state, error: 'access_denied' })).status).toBe(400);
    expect(mocks.sync).not.toHaveBeenCalled();
  });
  it('hides storage error details and sets no-store', async () => {
    mocks.list.mockRejectedValue(new Error('fixture-token must not leak'));
    const result = await request(app).get('/meta/sources');
    expect(result.status).toBe(503);
    expect(result.text).not.toContain('fixture-token');
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it('saves a verified catalogue under the initiating administrator and consumed state', async () => {
    vi.stubEnv('META_INSTAGRAM_APP_ID', '123'); vi.stubEnv('META_INSTAGRAM_APP_SECRET', 'fixture-secret');
    vi.stubEnv('META_SOURCES_CONFIG_ID', '456'); vi.stubEnv('META_SOURCES_REDIRECT_URI', 'https://api.example.test/api/integrations/meta/callback');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'fixture-token' }) })));
    mocks.consumeState.mockResolvedValue({ owner_user_id: '1' }); mocks.findUser.mockResolvedValue(mocks.user);
    const catalogue = { profile: { id: '15', name: 'Fixture' }, assets: [] };
    mocks.discover.mockResolvedValue(catalogue);
    const result = await request(app).get('/meta/callback').query({ state, code: 'fixture-code' });
    expect(result.status).toBe(200);
    expect(mocks.sync).toHaveBeenCalledWith(1, 'fixture-token', catalogue, state);
    expect(result.text).not.toContain('fixture-token');
  });
  it('scopes the event journal to the authenticated owner', async () => {
    mocks.events.mockResolvedValue([]);
    const result = await request(app).get('/meta/events').query({ projectId: '11', ownerId: '999' });
    expect(result.status).toBe(200); expect(mocks.events).toHaveBeenCalledWith(1, '11');
  });
  it('rejects event operations for employees', async () => {
    mocks.user = { id: 2, role: 'MANAGER', is_active: true };
    expect((await request(app).get('/meta/events')).status).toBe(403);
    expect((await request(app).post(`/meta/events/${sourceId}/assign`)).status).toBe(403);
    expect(mocks.assign).not.toHaveBeenCalled();
  });
  it('assigns an unassigned event through the server-side source binding', async () => {
    mocks.assign.mockResolvedValue(true);
    expect((await request(app).post(`/meta/events/${sourceId}/assign`).send({ expectedProjectId: '11', projectId: '999', ownerId: '999' })).status).toBe(200);
    expect(mocks.assign).toHaveBeenCalledWith(1, sourceId, '11');
  });
});
