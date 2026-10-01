import { SmsEventsRepository } from './smsEvents.repository.js';
import { defaultSmsEventsService } from './smsEvents.service.js';
import { defaultSmsService } from './sms.service.js';
import { LeadsRepository } from '../leads/leads.repository.js';
import { normalizePhoneNumber } from '../../utils/phoneNormalizer.js';
import { parseOptionalBigInt } from '../../utils/idNormalizer.js';
import { SmsRepository } from './sms.repository.js';

export class SmsAutoDispatcher {
  constructor(smsEventsService = defaultSmsEventsService, smsService = defaultSmsService) {
    this.smsEventsService = smsEventsService;
    this.smsService = smsService;
  }

  /**
   * Process pending AUTO PAYMENT_REMINDER events with state-machine safety.
   * Payom POST is called MAX 1 time per attempt.
   * Single sms_messages attempt row is created before provider send and updated with final status.
   */
  async dispatchPendingAutoReminders({ batchLimit = null } = {}) {
    const isAutoEnabled = process.env.SMS_PAYMENT_REMINDER_AUTO_ENABLED === 'true';
    const isDetectorEnabled = process.env.SMS_PAYMENT_REMINDER_DETECTOR_ENABLED === 'true';

    if (!isAutoEnabled || !isDetectorEnabled) {
      return {
        executed: false,
        reason: !isAutoEnabled ? 'AUTO_ENABLED_FALSE' : 'DETECTOR_ENABLED_FALSE',
        scanned: 0,
        claimed: 0,
        sent: 0,
        failed: 0,
        deliveryUnknown: 0,
        skipped: 0,
        errors: 0
      };
    }

    const limit = Math.min(
      100,
      Math.max(1, parseInt(batchLimit || process.env.SMS_AUTO_DISPATCH_BATCH_LIMIT || 5, 10))
    );

    const pendingEvents = await SmsEventsRepository.listPendingAutoEvents({ limit });

    const stats = {
      executed: true,
      scanned: pendingEvents.length,
      claimed: 0,
      sent: 0,
      failed: 0,
      deliveryUnknown: 0,
      skipped: 0,
      errors: 0
    };

    for (const event of pendingEvents) {
      if (event.mode !== 'AUTO' || event.event_type !== 'PAYMENT_REMINDER') {
        stats.skipped++;
        continue;
      }

      // 1. Atomic claim: transition status from AWAITING_CONFIRMATION to PROCESSING
      const claimedEvent = await SmsEventsRepository.atomicStartProcessing(event.id);
      if (!claimedEvent) {
        stats.skipped++;
        continue;
      }
      stats.claimed++;

      try {
        // 2. Validate Context Integrity
        try {
          await this.smsEventsService.validateEventContext(claimedEvent);
        } catch (err) {
          if (['SCHEDULE_ALREADY_PAID', 'DEBT_CLEARED', 'MEETING_CLOSED_OR_CANCELLED', 'DEAL_CANCELLED', 'PAYMENT_VOIDED'].includes(err.code)) {
            await SmsEventsRepository.cancelEvent({ id: claimedEvent.id, reason: err.message });
            stats.skipped++;
            continue;
          }
          throw err;
        }

        // 3. Resolve Authoritative Lead and Phone
        const clientId = parseOptionalBigInt(claimedEvent.client_id);
        const lead = clientId ? await LeadsRepository.findById(clientId) : null;
        const rawPhone = lead?.phone || lead?.secondary_phone || claimedEvent.phone || claimedEvent.recipient_phone;
        const normPhone = normalizePhoneNumber(rawPhone);

        if (!normPhone.isValid) {
          await SmsEventsRepository.markFailed({
            id: claimedEvent.id,
            failureCode: 'INVALID_PHONE',
            failureMessage: 'Телефон клиента отсутствует или невалиден'
          });
          stats.failed++;
          continue;
        }

        // 4. Server-side Preview Re-validation
        const preview = await this.smsService.previewSms({
          templateCode: claimedEvent.template_code,
          clientId: claimedEvent.client_id,
          dealId: claimedEvent.deal_id,
          paymentId: claimedEvent.payment_id,
          taskId: claimedEvent.task_id
        });

        if (!preview || !preview.text || preview.text.includes('{{')) {
          await SmsEventsRepository.markFailed({
            id: claimedEvent.id,
            failureCode: 'UNRESOLVED_PLACEHOLDERS',
            failureMessage: 'Текст SMS содержит неразрешённые шаблоны'
          });
          stats.failed++;
          continue;
        }

        // 5. Pre-send attempt record in sms_messages (status: queued)
        const attemptRow = await SmsRepository.createMessage({
          clientId: claimedEvent.client_id,
          dealId: claimedEvent.deal_id,
          paymentId: claimedEvent.payment_id,
          eventId: claimedEvent.id,
          phone: normPhone.normalized,
          message: preview.text,
          status: 'queued',
          provider: 'PAYOM',
          createdBy: null
        });

        const attemptId = attemptRow.id;

        // 6. Provider Call
        let providerResult;
        try {
          providerResult = await this.smsService.provider.sendSms({
            phone: normPhone.normalized,
            text: preview.text
          });
        } catch (sendErr) {
          const isTimeoutOrNetwork =
            sendErr.code === 'ETIMEDOUT' ||
            sendErr.code === 'ECONNRESET' ||
            sendErr.code === 'ENOTFOUND' ||
            sendErr.message?.toLowerCase().includes('timeout');

          if (isTimeoutOrNetwork) {
            await SmsRepository.updateMessageStatus(attemptId, {
              status: 'DELIVERY_UNKNOWN',
              errorCode: 'PAYOM_TIMEOUT',
              errorMessage: sendErr.message
            });
            await SmsEventsRepository.markDeliveryUnknown({
              id: claimedEvent.id,
              failureCode: 'PAYOM_TIMEOUT',
              failureMessage: sendErr.message
            });
            stats.deliveryUnknown++;
            continue;
          } else {
            await SmsRepository.updateMessageStatus(attemptId, {
              status: 'failed',
              errorCode: sendErr.code || 'PROVIDER_ERROR',
              errorMessage: sendErr.message
            });
            await SmsEventsRepository.markFailed({
              id: claimedEvent.id,
              failureCode: sendErr.code || 'PROVIDER_ERROR',
              failureMessage: sendErr.message
            });
            stats.failed++;
            continue;
          }
        }

        // 7. Process Provider Result
        if (providerResult && providerResult.success) {
          await SmsRepository.updateMessageStatus(attemptId, {
            status: 'sent',
            providerMessageId: providerResult.data?.provider_message_id || null,
            sentAt: new Date().toISOString()
          });
          await SmsEventsRepository.markSent({
            id: claimedEvent.id,
            userId: null
          });
          stats.sent++;
        } else {
          const errMsg = providerResult?.error?.message || 'Payom отклонил отправку SMS';
          const errCode = providerResult?.error?.code || 'PAYOM_REJECTED';
          await SmsRepository.updateMessageStatus(attemptId, {
            status: 'failed',
            errorCode: errCode,
            errorMessage: errMsg
          });
          await SmsEventsRepository.markFailed({
            id: claimedEvent.id,
            failureCode: errCode,
            failureMessage: errMsg
          });
          stats.failed++;
        }
      } catch (err) {
        console.error(`Error auto-dispatching event ${event.id}:`, err.message);
        await SmsEventsRepository.markFailed({
          id: claimedEvent.id,
          failureCode: 'AUTO_DISPATCH_ERROR',
          failureMessage: err.message
        });
        stats.errors++;
      }
    }

    return stats;
  }
}

export const defaultSmsAutoDispatcher = new SmsAutoDispatcher();
