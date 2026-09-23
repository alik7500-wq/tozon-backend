import { Router } from 'express';
import { protect, checkPermission } from '../../middleware/auth.middleware.js';
import { sendSms, getHistory, getTemplates, previewSms, getTemplateAvailability } from './sms.controller.js';

const router = Router();

// Protect all SMS routes
router.use(protect);

// Routes
router.post('/template-availability', checkPermission('sms.send'), getTemplateAvailability);
router.post('/preview', checkPermission('sms.send'), previewSms);
router.post('/send', checkPermission('sms.send'), sendSms);
router.get('/history', checkPermission('sms.history'), getHistory);
router.get('/templates', getTemplates);

export default router;
