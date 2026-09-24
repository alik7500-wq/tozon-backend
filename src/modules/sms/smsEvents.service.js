import crypto from 'crypto';
import { SmsEventsRepository } from './smsEvents.repository.js';
import { defaultSmsService } from './sms.service.js';
import { LeadsRepository } from '../leads/leads.repository.js';
import { DealsRepository } from '../deals/deals.repository.js';
import { TasksRepository } from '../tasks/tasks.repository.js';
import { SmsRepository } from './sms.repository.js';
import { AppError } from '../../shared/errors/errorHandler.js';

function parseOptionalBigInt(val) {
  if (val === undefined || val === null || val === '') return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

export class SmsEventsService {
  constructor(smsService = defaultSmsService) {
    this.smsService = smsService;
  }

  /**
   * Helper to compute deterministic preview hash.
   */
  computePreviewHash(text, eventId) {
    return crypto.createHash('sha256').update(`${text}:${eventId}`).digest('hex');
  }

  /**
   * List outbox events with pagination and filtering.
   */
  async listEvents(filters = {}) {
    return await SmsEventsRepository.listEvents(filters);
  }

  /**
   * Get single event by ID.
   */
  async getEventById(id) {
    const event = await SmsEventsRepository.getById(id);
    if (!event) {
      throw new AppError(`Событие SMS Outbox с ID ${id} не найдено`, 404);
    }
    return event;
  }

  /**
   * Re-validate source context integrity against authoritative DB tables.
   * Auto-cancels stale events if context is no longer applicable.
   */
  async validateEventContext(event) {
    const clientId = parseOptionalBigInt(event.client_id);
    const dealId = parseOptionalBigInt(event.deal_id);
    const paymentId = parseOptionalBigInt(event.payment_id);
    const scheduleId = parseOptionalBigInt(event.schedule_id);
    const taskId = parseOptionalBigInt(event.task_id);

    if (clientId) {
      const lead = await LeadsRepository.findById(clientId);
      if (!lead) {
        throw new AppError(`Клиент с ID ${clientId} не найден`, 404);
      }
    }

    if (dealId) {
      const deal = await DealsRepository.getDealById(dealId);
      if (!deal) {
        throw new AppError(`Сделка с ID ${dealId} не найдена`, 404);
      }
      if (deal.status === 'CANCELLED') {
        throw new AppError('Сделка отменена (EVENT_NO_LONGER_APPLICABLE)', 400, 'DEAL_CANCELLED');
      }
      if (clientId && parseOptionalBigInt(deal.lead_id) !== clientId) {
        throw new AppError('Сделка не принадлежит указанному клиенту', 400);
      }
    }

    if (paymentId) {
      const payment = await DealsRepository.getPaymentById(paymentId);
      if (!payment) {
        throw new AppError(`Платёж с ID ${paymentId} не найден`, 404);
      }
      if (payment.status === 'VOIDED') {
        throw new AppError('Платёж был аннулирован (EVENT_NO_LONGER_APPLICABLE)', 400, 'PAYMENT_VOIDED');
      }
      if (dealId && parseOptionalBigInt(payment.deal_id) !== dealId) {
        throw new AppError('Платёж не относится к указанной сделке', 400);
      }
    }

    if (scheduleId && dealId) {
      const deal = await DealsRepository.getDealById(dealId);
      const schedules = deal?.schedules || deal?.deal_payment_schedules || [];
      const sched = schedules.find((s) => parseOptionalBigInt(s.id) === scheduleId);
      if (sched) {
        const unpaidMinor = (sched.amount_minor || 0) - (sched.paid_amount_minor || 0);
        if (unpaidMinor <= 0) {
          throw new AppError('График платежа уже полностью оплачен (EVENT_NO_LONGER_APPLICABLE)', 400, 'SCHEDULE_ALREADY_PAID');
        }
      }
    }

    if (taskId) {
      const task = await TasksRepository.findById(taskId);
      if (!task) {
        throw new AppError(`Задача с ID ${taskId} не найдена`, 404);
      }
      if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
        throw new AppError('Запланированная встреча завершена или отменена (EVENT_NO_LONGER_APPLICABLE)', 400, 'MEETING_CLOSED_OR_CANCELLED');
      }
    }

    return true;
  }

  /**
   * Server-side preview of outbox event using authoritative DB state.
   * Payom calls = 0. Does NOT change event status.
   */
  async previewEvent(id) {
    const event = await this.getEventById(id);
    
    try {
      await this.validateEventContext(event);
    } catch (err) {
      if (['SCHEDULE_ALREADY_PAID', 'DEBT_CLEARED', 'MEETING_CLOSED_OR_CANCELLED', 'DEAL_CANCELLED', 'PAYMENT_VOIDED'].includes(err.code)) {
        if (event.status === 'AWAITING_CONFIRMATION') {
          await SmsEventsRepository.cancelEvent({ id: event.id, reason: err.message });
        }
        return {
          event: { ...event, status: 'CANCELLED', cancel_reason: err.message },
          isApplicable: false,
          cancelReason: err.message,
          text: '',
          characterCount: 0,
          smsSegments: 0,
          previewHash: null
        };
      }
      throw err;
    }

    const previewResult = await this.smsService.previewSms({
      templateCode: event.template_code,
      clientId: event.client_id,
      dealId: event.deal_id,
      paymentId: event.payment_id,
      taskId: event.task_id
    });

    const previewHash = this.computePreviewHash(previewResult.text, event.id);

    return {
      event,
      isApplicable: true,
      text: previewResult.text,
      characterCount: previewResult.characterCount,
      smsSegments: previewResult.smsSegments,
      isUnicode: previewResult.isUnicode,
      previewHash
    };
  }

  /**
   * Cancel an event awaiting confirmation.
   */
  async cancelEvent({ id, userId = null, reason = null }) {
    const event = await this.getEventById(id);
    if (event.status !== 'AWAITING_CONFIRMATION') {
      throw new AppError(`Событие ${id} находится в статусе ${event.status} и не может быть отменено`, 400);
    }

    const cleanReason = reason ? String(reason).trim().substring(0, 500) : 'Отменено менеджером';
    const updatedEvent = await SmsEventsRepository.cancelEvent({
      id: event.id,
      userId,
      reason: cleanReason
    });

    if (!updatedEvent) {
      throw new AppError('Не удалось отменить событие', 500);
    }

    return updatedEvent;
  }

  /**
   * Confirm and process event with atomic state claim & pre-send re-validation.
   */
  async confirmEvent({ id, userId = null, previewHash = null }) {
    const checkEvent = await SmsEventsRepository.getById(id);
    if (!checkEvent) {
      throw new AppError(`Событие SMS Outbox с ID ${id} не найдено`, 404);
    }

    if (['SENT', 'CANCELLED', 'DELIVERY_UNKNOWN'].includes(checkEvent.status)) {
      throw new AppError(`Событие с статусом [${checkEvent.status}] не может быть повторно отправлено`, 400, 'EVENT_NOT_CONFIRMABLE');
    }

    // 1. Atomic claim: transition AWAITING_CONFIRMATION -> PROCESSING
    const claimedEvent = await SmsEventsRepository.atomicStartProcessing(id);
    if (!claimedEvent) {
      throw new AppError(`Событие не может быть подтверждено: текущий статус [${checkEvent.status}]`, 400, 'EVENT_NOT_CONFIRMABLE');
    }

    try {
      // 2. Re-validate source context
      try {
        await this.validateEventContext(claimedEvent);
      } catch (staleErr) {
        if (['SCHEDULE_ALREADY_PAID', 'DEBT_CLEARED', 'MEETING_CLOSED_OR_CANCELLED', 'DEAL_CANCELLED', 'PAYMENT_VOIDED'].includes(staleErr.code)) {
          await SmsEventsRepository.cancelEvent({ id: claimedEvent.id, userId, reason: staleErr.message });
          throw new AppError(`Событие больше не актуально: ${staleErr.message}`, 400, 'EVENT_NO_LONGER_APPLICABLE');
        }
        throw staleErr;
      }

      // 3. Re-resolve canonical template & text
      const previewResult = await this.smsService.previewSms({
        templateCode: claimedEvent.template_code,
        clientId: claimedEvent.client_id,
        dealId: claimedEvent.deal_id,
        paymentId: claimedEvent.payment_id,
        taskId: claimedEvent.task_id
      });

      const currentHash = this.computePreviewHash(previewResult.text, claimedEvent.id);
      if (previewHash && currentHash !== previewHash) {
        // Preview text changed since manager viewed it! Revert status back to AWAITING_CONFIRMATION (0 Payom calls executed).
        await SmsEventsRepository.revertToAwaitingConfirmation(claimedEvent.id);
        throw new AppError('Текст сообщения изменился. Пожалуйста, проверьте обновлённый текст перед отправкой', 400, 'PREVIEW_CHANGED');
      }

      // 4. Feature Flag Protection for V1.5B.2
      const isTestEnv = process.env.NODE_ENV === 'test';
      const isConfirmEnabled = process.env.SMS_OUTBOX_CONFIRM_ENABLED === 'true';

      if (!isTestEnv && !isConfirmEnabled) {
        await SmsEventsRepository.cancelEvent({ id: claimedEvent.id, userId, reason: 'SMS_OUTBOX_CONFIRM_ENABLED_FALSE' });
        throw new AppError('Отправка SMS из Outbox заблокирована настройкой SMS_OUTBOX_CONFIRM_ENABLED', 400, 'OUTBOX_SEND_NOT_ENABLED');
      }

      // 5. Create pre-provider delivery attempt record in sms_messages linked by event_id
      let preAttemptId = null;
      try {
        const attemptMsg = await SmsRepository.createMessage({
          clientId: claimedEvent.client_id,
          phone: 'PENDING',
          message: previewResult.text,
          status: 'queued',
          createdBy: userId,
          dealId: claimedEvent.deal_id,
          paymentId: claimedEvent.payment_id,
          eventId: claimedEvent.id
        });
        preAttemptId = attemptMsg?.id || null;
      } catch (e) {
        console.warn('Failed to pre-record sms_messages attempt:', e.message);
      }

      // 6. Dispatch via SmsService (Exactly ONE Payom POST call)
      const sendResult = await this.smsService.sendSms({
        clientId: claimedEvent.client_id,
        text: previewResult.text,
        templateCode: claimedEvent.template_code,
        dealId: claimedEvent.deal_id,
        paymentId: claimedEvent.payment_id,
        userId
      });

      if (!sendResult.success) {
        const failureCode = sendResult.error?.code || 'PAYOM_DISPATCH_FAILED';
        const failureMessage = sendResult.error?.message || 'Ошибка отправки через провайдер';

        if (failureCode === 'PAYOM_TIMEOUT') {
          const updated = await SmsEventsRepository.markDeliveryUnknown({ id: claimedEvent.id, failureCode, failureMessage });
          return { success: false, event: updated, error: sendResult.error };
        } else {
          const updated = await SmsEventsRepository.markFailed({ id: claimedEvent.id, failureCode, failureMessage });
          return { success: false, event: updated, error: sendResult.error };
        }
      }

      const smsMessageId = sendResult.data?.id || preAttemptId;
      const updatedEvent = await SmsEventsRepository.markSent({
        id: claimedEvent.id,
        smsMessageId,
        userId
      });

      return {
        success: true,
        event: updatedEvent,
        smsMessage: sendResult.data
      };

    } catch (err) {
      if (!['OUTBOX_SEND_NOT_ENABLED', 'PREVIEW_CHANGED', 'EVENT_NO_LONGER_APPLICABLE'].includes(err.code)) {
        await SmsEventsRepository.markFailed({
          id: claimedEvent.id,
          failureCode: err.code || 'CONTEXT_VALIDATION_FAILED',
          failureMessage: err.message
        });
      }
      throw err;
    }
  }
}

export const defaultSmsEventsService = new SmsEventsService();
