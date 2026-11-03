import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../middleware/auth.middleware.js', () => ({
  protect: (req, res, next) => {
    if (req.headers.authorization !== 'Bearer test-auth') return res.status(401).json({ status: 'error' });
    req.user = { id: 1, role: req.headers['x-test-role'] || 'ADMIN' };
    next();
  }
}));
vi.mock('../modules/integrations/instagram-connection.repository.js', () => ({
  getTozonInstagramConnectionStatus: vi.fn().mockResolvedValue({ connected: false, available: true }),
  saveTozonInstagramConnection: vi.fn()
}));
vi.mock('../modules/integrations/instagram-oauth.repository.js', () => ({
  saveInstagramOAuthState: vi.fn(),
  consumeInstagramOAuthState: vi.fn().mockResolvedValue(null)
}));

import instagramRouter from '../modules/integrations/instagram.router.js';

const app = express();
app.use(express.json());
app.use('/api/integrations/instagram', instagramRouter);

describe('Instagram integration security', () => {
  it('requires authentication for connection status', async () => {
    expect((await request(app).get('/api/integrations/instagram/connection')).status).toBe(401);
  });

  it('requires an administrator for connection status', async () => {
    const r = await request(app).get('/api/integrations/instagram/connection')
      .set('Authorization', 'Bearer test-auth').set('x-test-role', 'MANAGER');
    expect(r.status).toBe(403);
  });

  it('reports the database status without a token', async () => {
    const r = await request(app).get('/api/integrations/instagram/connection')
      .set('Authorization', 'Bearer test-auth');
    expect(r.status).toBe(200);
    expect(r.body.data.connected).toBe(false);
    expect(r.body.data).not.toHaveProperty('accessToken');
  });

  it('rejects OAuth start without configured Meta credentials', async () => {
    const r = await request(app).post('/api/integrations/instagram/connect')
      .set('Authorization', 'Bearer test-auth');
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('INSTAGRAM_OAUTH_UNAVAILABLE');
  });

  it('rejects missing OAuth callback parameters', async () => {
    const r = await request(app).get('/api/integrations/instagram/callback');
    expect(r.status).toBe(400);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('rejects an expired or unknown OAuth state', async () => {
    const r = await request(app).get('/api/integrations/instagram/callback?code=invalid&state=invalid');
    expect(r.status).toBe(403);
  });
});
