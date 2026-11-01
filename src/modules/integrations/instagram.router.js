import { Router } from 'express';
import { protect } from '../../middleware/auth.middleware.js';

const router = Router();

router.get('/connection', protect, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'success', data: { provider: 'instagram', connected: false, available: false } });
});

router.post('/connect', protect, (_req, res) => {
  res.status(503).json({ status: 'error', code: 'INSTAGRAM_OAUTH_NOT_READY' });
});

router.get('/callback', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(503).send('Instagram integration is not configured');
});

export default router;
