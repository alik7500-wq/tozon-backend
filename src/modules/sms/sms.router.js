import { Router } from 'express';
import { protect, checkPermission, restrictTo } from '../../middleware/auth.middleware.js';
import { sendSms, getHistory, getTemplates, previewSms, getTemplateAvailability } from './sms.controller.js';
import { listEvents, getEventById, previewEvent, cancelEvent, confirmEvent, reconcileEvent, dryRunPaymentReminderDetector, runPaymentReminderDetector } from './smsEvents.controller.js';

import smsSettingsRouter from './smsSettings.router.js';
const router = Router();

// Protect all SMS routes
router.use(protect);
router.use('/settings', smsSettingsRouter);

// SMS Outbox Events Routes
router.get('/events', checkPermission('sms.history'), listEvents);
router.get('/events/:id', checkPermission('sms.history'), getEventById);
router.post('/events/:id/preview', checkPermission('sms.send'), previewEvent);
router.post('/events/:id/cancel', checkPermission('sms.send'), cancelEvent);
router.post('/events/:id/confirm', checkPermission('sms.send'), confirmEvent);
router.post('/events/:id/reconcile', checkPermission('sms.send'), reconcileEvent);

// Detector Endpoints (Admin/Director Restricted)
router.post('/detectors/payment-reminder/dry-run', restrictTo('ADMIN', 'DIRECTOR'), dryRunPaymentReminderDetector);
router.post('/detectors/payment-reminder/run', restrictTo('ADMIN', 'DIRECTOR'), runPaymentReminderDetector);

// Standard Direct SMS Routes
router.post('/template-availability', checkPermission('sms.send'), getTemplateAvailability);
router.post('/preview', checkPermission('sms.send'), previewSms);
router.post('/send', checkPermission('sms.send'), sendSms);
router.get('/history', checkPermission('sms.history'), getHistory);
router.get('/templates', getTemplates);

export default router;
