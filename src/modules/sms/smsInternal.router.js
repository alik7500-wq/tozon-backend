import { Router } from 'express';
import { verifySchedulerToken } from '../../middleware/schedulerAuth.middleware.js';
import { runInternalPaymentReminderScheduler } from './smsScheduler.controller.js';

const router = Router();

// Endpoint for automated internal scheduler execution (e.g. Render Cron)
router.post('/payment-reminder/run', verifySchedulerToken, runInternalPaymentReminderScheduler);

export default router;
