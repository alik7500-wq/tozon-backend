import { Router } from 'express';
import { protect, checkPermission } from '../../middleware/auth.middleware.js';
import { sendSms, getHistory, getTemplates, previewSms, getTemplateAvailability } from './sms.controller.js';
import { listEvents, getEventById, previewEvent, cancelEvent, confirmEvent } from './smsEvents.controller.js';

const router = Router();

// Protect all SMS routes
router.use(protect);

// SMS Outbox Events Routes
router.get('/events', checkPermission('sms.history'), listEvents);
router.get('/events/:id', checkPermission('sms.history'), getEventById);
router.post('/events/:id/preview', checkPermission('sms.send'), previewEvent);
router.post('/events/:id/cancel', checkPermission('sms.send'), cancelEvent);
router.post('/events/:id/confirm', checkPermission('sms.send'), confirmEvent);

// Standard Direct SMS Routes
router.post('/template-availability', checkPermission('sms.send'), getTemplateAvailability);
router.post('/preview', checkPermission('sms.send'), previewSms);
router.post('/send', checkPermission('sms.send'), sendSms);
router.get('/history', checkPermission('sms.history'), getHistory);
router.get('/templates', getTemplates);

export default router;
