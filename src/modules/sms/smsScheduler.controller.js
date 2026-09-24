import { AppError } from '../../shared/errors/errorHandler.js';
import { PaymentReminderDetector } from './paymentReminderDetector.js';

export async function runInternalPaymentReminderScheduler(req, res, next) {
  const startTime = Date.now();
  try {
    const isEnabled = process.env.SMS_PAYMENT_REMINDER_DETECTOR_ENABLED === 'true';
    if (!isEnabled) {
      throw new AppError('Детектор PAYMENT_REMINDER отключен настройкой SMS_PAYMENT_REMINDER_DETECTOR_ENABLED', 400, 'DETECTOR_NOT_ENABLED');
    }

    console.log('[SMS_SCHEDULER] Internal payment reminder scheduler triggered');

    const stats = await PaymentReminderDetector.detectPaymentReminders({
      businessDate: null,
      isDryRun: false
    });

    const durationMs = Date.now() - startTime;
    console.log('[SMS_SCHEDULER] Execution completed', {
      businessDate: stats.businessDate,
      scanned: stats.scanned,
      eligible: stats.eligible,
      created: stats.created,
      already_exists: stats.already_exists,
      cancelled_stale: stats.cancelled_stale,
      errors: stats.errors,
      duration_ms: durationMs
    });

    return res.status(200).json({
      success: true,
      message: 'Внутренний запуск планировщика PAYMENT_REMINDER успешно выполнен',
      data: {
        businessDate: stats.businessDate,
        scanned: stats.scanned,
        eligible: stats.eligible,
        created: stats.created,
        already_exists: stats.already_exists,
        cancelled_stale: stats.cancelled_stale,
        skipped_paid: stats.skipped_paid,
        skipped_overdue: stats.skipped_overdue,
        skipped_invalid_phone: stats.skipped_invalid_phone,
        skipped_ineligible_deal: stats.skipped_ineligible_deal,
        errors: stats.errors,
        candidatesCount: (stats.candidates || []).length
      }
    });
  } catch (err) {
    const durationMs = Date.now() - startTime;
    console.error('[SMS_SCHEDULER] Execution failed', {
      error: err.message,
      code: err.code || err.errorCode,
      duration_ms: durationMs
    });
    next(err);
  }
}
