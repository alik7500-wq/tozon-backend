import express from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { protect, restrictTo } from '../../middleware/auth.middleware.js';
import { analyzePassport, confirmPassportScan } from './documents.controller.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB limit per image file
    files: 4 // Up to 4 pages/images per request
  }
});

const passportScannerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Limit each IP / user to 30 recognition requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Превышен лимит запросов сканирования паспортов. Попробуйте через 15 минут.'
    }
  }
});

// Protected routes
router.use(protect);
router.use(restrictTo('ADMIN', 'DIRECTOR', 'SALES_MANAGER', 'FINANCE_MANAGER'));

router.post(
  '/passport/analyze',
  passportScannerLimiter,
  upload.array('images', 4),
  analyzePassport
);

router.post(
  '/passport/confirm',
  confirmPassportScan
);

export default router;
