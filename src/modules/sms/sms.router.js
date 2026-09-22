import { Router } from 'express';
import { protect, checkPermission } from '../../middleware/auth.middleware.js';
import { sendSms, getHistory, getTemplates } from './sms.controller.js';

const router = Router();

// Protect all SMS routes
router.use(protect);

// Routes
router.post('/send', checkPermission('sms.send'), sendSms);
router.get('/history', getHistory);
router.get('/templates', getTemplates);

export default router;
