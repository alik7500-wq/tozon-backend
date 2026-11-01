import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../middleware/auth.middleware.js', () => ({
  protect: (req, res, next) => {
    if (req.headers.authorization !== 'Bearer test-auth') {
      return res.status(401).json({ status: 'error' });
    }
    next();
  }
}));

import instagramRouter from '../modules/integrations/instagram.router.js';

const app = express();
app.use(express.json());
app.use('/api/integrations/instagram', instagramRouter);

describe('Instagram integration scaffold: fail closed', () => {
  it('requires authentication for connection status', async () => {
    const response = await request(app).get('/api/integrations/instagram/connection');
    expect(response.status).toBe(401);
  });

  it('does not falsely report a connected account', async () => {
    const response = await request(app).get('/api/integrations/instagram/connection')
      .set('Authorization', 'Bearer test-auth');
    expect(response.status).toBe(200);
    expect(response.body.data.connected).toBe(false);
    expect(response.body.data.available).toBe(false);
  });

  it('does not start an unfinished OAuth flow', async () => {
    const response = await request(app).post('/api/integrations/instagram/connect')
      .set('Authorization', 'Bearer test-auth');
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('INSTAGRAM_OAUTH_NOT_READY');
  });

  it('rejects callbacks before OAuth state verification exists', async () => {
    const response = await request(app).get('/api/integrations/instagram/callback?code=untrusted&state=untrusted');
    expect(response.status).toBe(503);
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
