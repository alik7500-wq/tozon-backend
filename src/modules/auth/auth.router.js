import express from 'express';
import { login, logout, createSendToken } from './auth.service.js';
import { protect } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { UsersRepository } from '../users/users.repository.js';

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    await login(email, password, res);
  } catch (error) {
    next(error);
  }
});

router.post('/dev-login', async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await UsersRepository.findByEmail(email);
    if (!user) return next(new AppError('User not found', 404));
    createSendToken(user, 200, res);
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
