import { presence, safeActivity } from '../activity/activity.service.js';
import express from 'express';
import { login, logout } from './auth.service.js';
import { protect, protectOptional } from '../../middleware/auth.middleware.js';

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    await login(email, password, res);
  } catch (error) {
    next(error);
  }
});

router.post('/logout', protectOptional, async (req, res) => {
  if (req.user) await safeActivity(() => presence(req.user, { last_logout_at: new Date().toISOString() }));
  logout(res);
});

router.get('/me', protect, (req, res) => {
  res.status(200).json({
    status: 'success',
    data: {
      user: req.user
    }
  });
});

export default router;
