import express from 'express';
import { login, logout } from './auth.service.js';
import { protect } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    await login(email, password, res);
  } catch (error) {
    next(error);
  }
});

router.post('/logout', (req, res) => {
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
