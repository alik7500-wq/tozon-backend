import { SmsEventsRepository } from './smsEvents.repository.js';
import { defaultSmsService } from './sms.service.js';
import { LeadsRepository } from '../leads/leads.repository.js';
import { DealsRepository } from '../deals/deals.repository.js';
import { TasksRepository } from '../tasks/tasks.repository.js';
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
        throw new AppError('Платёж был аннулирован', 400);
      }
      if (dealId && parseOptionalBigInt(payment.deal_id) !== dealId) {
        throw new AppError('Платёж не относится к указанной сделке', 400);
      }
    }

    if (scheduleId && dealId) {
      const deal = await DealsRepository.getDealById(dealId);
      const schedules = deal?.schedules || deal?.deal_payment_schedules || [];
      const sched = schedules.find((s) => parseOptionalBigInt(s.id) === scheduleId);
      if (!sched && schedules.length > 0) {
        throw new AppError('График платежа не найден в указанной сделке', 400);
      }
    }

    if (taskId) {
      const task = await TasksRepository.findById(taskId);
      if (!task) {
        throw new AppError(`Задача с ID ${taskId} не найдена`, 404);
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
    await this.validateEventContext(event);

    const previewResult = await this.smsService.previewSms({
      templateCode: event.template_code,
      clientId: event.client_id,
      dealId: event.deal_id,
      paymentId: event.payment_id,
      taskId: event.task_id
    });

    return {
      event,
      text: previewResult.text,
      characterCount: previewResult.characterCount,
      smsSegments: previewResult.smsSegments,
      isUnicode: previewResult.isUnicode
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
   * Confirm and process event with atomic state claim.
   * On V1.5B.1, real production dispatch is protected by feature flag / controlled stub.
   */
  async confirmEvent({ id, userId = null }) {
    // 1. Atomic claim: transition AWAITING_CONFIRMATION -> PROCESSING
    const claimedEvent = await SmsEventsRepository.atomicStartProcessing(id);
    if (!claimedEvent) {
      const checkEvent = await SmsEventsRepository.getById(id);
      if (!checkEvent) {
        throw new AppError(`Событие SMS Outbox с ID ${id} не найдено`, 404);
      }
      throw new AppError(`Событие не может быть подтверждено: текущий статус [${checkEvent.status}]`, 400, 'EVENT_NOT_CONFIRMABLE');
    }

    try {
      // 2. Validate source context & re-resolve template
      await this.validateEventContext(claimedEvent);

      const previewResult = await this.smsService.previewSms({
        templateCode: claimedEvent.template_code,
        clientId: claimedEvent.client_id,
        dealId: claimedEvent.deal_id,
        paymentId: claimedEvent.payment_id,
        taskId: claimedEvent.task_id
      });

      // 3. Feature Flag / Mode Protection for V1.5B.1
      const isTestEnv = process.env.NODE_ENV === 'test';
      const isMockAllowed = process.env.SMS_OUTBOX_ALLOW_SEND === 'true';

      if (!isTestEnv && !isMockAllowed) {
        // Revert to AWAITING_CONFIRMATION or return controlled feature-disabled response
        await SmsEventsRepository.cancelEvent({ id: claimedEvent.id, userId, reason: 'V1.5B.1_CONFIRM_SEND_NOT_ENABLED' });
        throw new AppError('Отправка SMS из Outbox V1.5B.1 заблокирована до следующего этапа релиза', 400, 'OUTBOX_SEND_NOT_ENABLED');
      }

      // 4. Dispatch via SmsService
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

      const smsMessageId = sendResult.data?.id || null;
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
      if (err.code !== 'OUTBOX_SEND_NOT_ENABLED') {
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
