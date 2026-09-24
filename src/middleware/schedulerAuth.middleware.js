import crypto from 'crypto';
import { AppError } from '../shared/errors/errorHandler.js';

export const verifySchedulerToken = (req, res, next) => {
  try {
    const configuredToken = process.env.SMS_SCHEDULER_INTERNAL_TOKEN;

    if (!configuredToken || typeof configuredToken !== 'string' || configuredToken.trim() === '') {
      return next(new AppError('Внутренний токен планировщика не настроен на сервере', 503, 'SCHEDULER_NOT_CONFIGURED'));
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new AppError('Неверный формат или отсутствие заголовка Authorization', 401, 'INVALID_SCHEDULER_TOKEN'));
    }

    const providedToken = authHeader.substring(7).trim();
    const providedBuffer = Buffer.from(providedToken);
    const configuredBuffer = Buffer.from(configuredToken.trim());

    if (providedBuffer.length !== configuredBuffer.length) {
      return next(new AppError('Неверный токен авторизации планировщика', 401, 'INVALID_SCHEDULER_TOKEN'));
    }

    const isMatch = crypto.timingSafeEqual(providedBuffer, configuredBuffer);
    if (!isMatch) {
      return next(new AppError('Неверный токен авторизации планировщика', 401, 'INVALID_SCHEDULER_TOKEN'));
    }

    next();
  } catch (err) {
    next(err);
  }
};
