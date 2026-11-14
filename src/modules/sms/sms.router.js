import { Router } from 'express';
import { protect, checkPermission, restrictTo } from '../../middleware/auth.middleware.js';
import { sendSms, getHistory, getTemplates, previewSms, getTemplateAvailability } from './sms.controller.js';
import { listEvents, getEventById, previewEvent, cancelEvent, confirmEvent, reconcileEvent, dryRunPaymentReminderDetector, runPaymentReminderDetector } from './smsEvents.controller.js';

import {buyerOnboarding} from '../buyer-portal/instance.js';
import {BuyerPortalError} from '../buyer-portal/identity.service.js';
import rateLimit from 'express-rate-limit';
import smsSettingsRouter from './smsSettings.router.js';
const router = Router();

// Protect all SMS routes
router.use(protect);
router.use('/settings', smsSettingsRouter);
const onboardingRun=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{res.json({data:await fn(req)});}catch(e){res.status(e instanceof BuyerPortalError?e.statusCode:503).json({message:e instanceof BuyerPortalError?e.message:'BUYER_INVITATION_UNAVAILABLE'});}};
router.get('/buyer-invitations',checkPermission('sms.history'),onboardingRun(req=>buyerOnboarding.list(req.user)));
router.post('/buyer-invitations/preview',checkPermission('sms.send'),onboardingRun(req=>buyerOnboarding.preview(req.user,req.body||{})));
router.post('/buyer-invitations/send',checkPermission('sms.send'),rateLimit({windowMs:60000,limit:20,keyGenerator:req=>String(req.user.id)}),onboardingRun(req=>buyerOnboarding.send(req.user,req.body||{})));


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
