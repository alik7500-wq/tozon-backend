import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SmsAutoDispatcher } from '../smsAutoDispatcher.js';
import { SmsEventsRepository } from '../smsEvents.repository.js';
import { SmsRepository } from '../sms.repository.js';
import { LeadsRepository } from '../../leads/leads.repository.js';

describe('V1.6A AUTO PAYMENT_REMINDER Implementation Tests', () => {
  let mockSmsEventsService;
  let mockSmsService;
  let dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSmsEventsService = {
      validateEventContext: vi.fn().mockResolvedValue(true)
    };

    mockSmsService = {
      previewSms: vi.fn().mockResolvedValue({
        text: 'Здравствуйте, Малика! Напоминаем об очередной оплате по договору №0003 в размере 850 USD до 03.10.2026. TOZON-PLAZA.',
        characterCount: 130,
        smsSegments: 2,
        isUnicode: true
      }),
      provider: {
        sendSms: vi.fn().mockResolvedValue({
          success: true,
          data: { provider_message_id: 'PAYOM_AUTO_1001', status: 'sent' }
        })
      }
    };

    dispatcher = new SmsAutoDispatcher(mockSmsEventsService, mockSmsService);
  });

  it('A & B. AUTO flag absent or false returns executed=false with 0 Payom calls', async () => {
    delete process.env.SMS_PAYMENT_REMINDER_AUTO_ENABLED;
    process.env.SMS_PAYMENT_REMINDER_DETECTOR_ENABLED = 'true';

    const result = await dispatcher.dispatchPendingAutoReminders();
    expect(result.executed).toBe(false);
    expect(result.reason).toBe('AUTO_ENABLED_FALSE');
    expect(mockSmsService.provider.sendSms).not.toHaveBeenCalled();

    process.env.SMS_PAYMENT_REMINDER_AUTO_ENABLED = 'false';
    const resultFalse = await dispatcher.dispatchPendingAutoReminders();
    expect(resultFalse.executed).toBe(false);
    expect(resultFalse.reason).toBe('AUTO_ENABLED_FALSE');
    expect(mockSmsService.provider.sendSms).not.toHaveBeenCalled();
  });

  it('C & O. AUTO flag true but event is CONFIRM mode -> no auto send', async () => {
    process.env.SMS_PAYMENT_REMINDER_AUTO_ENABLED = 'true';
    process.env.SMS_PAYMENT_REMINDER_DETECTOR_ENABLED = 'true';

    vi.spyOn(SmsEventsRepository, 'listPendingAutoEvents').mockResolvedValue([]);

    const result = await dispatcher.dispatchPendingAutoReminders();
    expect(result.executed).toBe(true);
    expect(result.claimed).toBe(0);
    expect(result.sent).toBe(0);
    expect(mockSmsService.provider.sendSms).not.toHaveBeenCalled();
  });

  it('D, E, K, Q & R. AUTO flag true + AUTO PAYMENT_REMINDER -> 1 claim, 1 attempt row, 1 Payom POST, transitions to SENT', async () => {
    process.env.SMS_PAYMENT_REMINDER_AUTO_ENABLED = 'true';
    process.env.SMS_PAYMENT_REMINDER_DETECTOR_ENABLED = 'true';

    const mockAutoEvent = {
      id: 50,
      event_type: 'PAYMENT_REMINDER',
      mode: 'AUTO',
      status: 'AWAITING_CONFIRMATION',
      client_id: 13,
      deal_id: 13,
      schedule_id: 298,
      template_code: 'PAYMENT_REMINDER',
      contract_number: '0003'
    };

    const { LeadsRepository } = await import('../../leads/leads.repository.js');
    vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 13, phone: '+992999333000' });
    vi.spyOn(SmsEventsRepository, 'listPendingAutoEvents').mockResolvedValue([mockAutoEvent]);
    vi.spyOn(SmsEventsRepository, 'atomicStartProcessing').mockResolvedValue({ ...mockAutoEvent, status: 'PROCESSING' });
    vi.spyOn(SmsRepository, 'createMessage').mockResolvedValue({ id: 901, status: 'queued' });
    vi.spyOn(SmsRepository, 'updateMessageStatus').mockResolvedValue({ id: 901, status: 'sent' });
    vi.spyOn(SmsEventsRepository, 'markSent').mockResolvedValue({ ...mockAutoEvent, status: 'SENT' });

    const result = await dispatcher.dispatchPendingAutoReminders();

    expect(result.executed).toBe(true);
    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(1);
    expect(mockSmsService.provider.sendSms).toHaveBeenCalledTimes(1);
    expect(SmsRepository.createMessage).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 50,
      phone: '+992999333000',
      status: 'queued'
    }));
    expect(SmsEventsRepository.markSent).toHaveBeenCalledWith(expect.objectContaining({ id: 50 }));
  });

  it('F. Provider definitive failure transitions event and message to FAILED', async () => {
    process.env.SMS_PAYMENT_REMINDER_AUTO_ENABLED = 'true';
    process.env.SMS_PAYMENT_REMINDER_DETECTOR_ENABLED = 'true';

    const mockAutoEvent = { id: 51, event_type: 'PAYMENT_REMINDER', mode: 'AUTO', status: 'AWAITING_CONFIRMATION', client_id: 13, deal_id: 13, template_code: 'PAYMENT_REMINDER' };

    const { LeadsRepository } = await import('../../leads/leads.repository.js');
    vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 13, phone: '+992999333000' });
    vi.spyOn(SmsEventsRepository, 'listPendingAutoEvents').mockResolvedValue([mockAutoEvent]);
    vi.spyOn(SmsEventsRepository, 'atomicStartProcessing').mockResolvedValue({ ...mockAutoEvent, status: 'PROCESSING' });
    vi.spyOn(SmsRepository, 'createMessage').mockResolvedValue({ id: 902, status: 'queued' });
    vi.spyOn(SmsRepository, 'updateMessageStatus').mockResolvedValue({ id: 902, status: 'failed' });
    vi.spyOn(SmsEventsRepository, 'markFailed').mockResolvedValue({ ...mockAutoEvent, status: 'FAILED' });

    mockSmsService.provider.sendSms.mockResolvedValueOnce({
      success: false,
      error: { code: 'PAYOM_REJECTED', message: 'Invalid recipient phone' }
    });

    const result = await dispatcher.dispatchPendingAutoReminders();

    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
    expect(SmsEventsRepository.markFailed).toHaveBeenCalledWith(expect.objectContaining({
      id: 51,
      failureCode: 'PAYOM_REJECTED'
    }));
  });

  it('G & H. Timeout / Network error transitions to DELIVERY_UNKNOWN with 0 automatic retry', async () => {
    process.env.SMS_PAYMENT_REMINDER_AUTO_ENABLED = 'true';
    process.env.SMS_PAYMENT_REMINDER_DETECTOR_ENABLED = 'true';

    const mockAutoEvent = { id: 52, event_type: 'PAYMENT_REMINDER', mode: 'AUTO', status: 'AWAITING_CONFIRMATION', client_id: 13, deal_id: 13, template_code: 'PAYMENT_REMINDER' };

    const { LeadsRepository } = await import('../../leads/leads.repository.js');
    vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 13, phone: '+992999333000' });
    vi.spyOn(SmsEventsRepository, 'listPendingAutoEvents').mockResolvedValue([mockAutoEvent]);
    vi.spyOn(SmsEventsRepository, 'atomicStartProcessing').mockResolvedValue({ ...mockAutoEvent, status: 'PROCESSING' });
    vi.spyOn(SmsRepository, 'createMessage').mockResolvedValue({ id: 903, status: 'queued' });
    vi.spyOn(SmsRepository, 'updateMessageStatus').mockResolvedValue({ id: 903, status: 'DELIVERY_UNKNOWN' });
    vi.spyOn(SmsEventsRepository, 'markDeliveryUnknown').mockResolvedValue({ ...mockAutoEvent, status: 'DELIVERY_UNKNOWN' });
    vi.spyOn(SmsEventsRepository, 'revertToAwaitingConfirmation').mockResolvedValue(null);

    const timeoutErr = new Error('Gateway timeout after 5000ms');
    timeoutErr.code = 'ETIMEDOUT';
    mockSmsService.provider.sendSms.mockRejectedValueOnce(timeoutErr);

    const result = await dispatcher.dispatchPendingAutoReminders();

    expect(result.deliveryUnknown).toBe(1);
    expect(SmsEventsRepository.markDeliveryUnknown).toHaveBeenCalledWith(expect.objectContaining({
      id: 52,
      failureCode: 'PAYOM_TIMEOUT'
    }));
    expect(SmsEventsRepository.revertToAwaitingConfirmation).not.toHaveBeenCalled();
  });

  it('I & J. Concurrent dispatcher runs: atomicStartProcessing prevents duplicate Payom POSTs', async () => {
    process.env.SMS_PAYMENT_REMINDER_AUTO_ENABLED = 'true';
    process.env.SMS_PAYMENT_REMINDER_DETECTOR_ENABLED = 'true';

    const mockAutoEvent = { id: 53, event_type: 'PAYMENT_REMINDER', mode: 'AUTO', status: 'AWAITING_CONFIRMATION', client_id: 13, deal_id: 13, template_code: 'PAYMENT_REMINDER' };

    const { LeadsRepository } = await import('../../leads/leads.repository.js');
    vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 13, phone: '+992999333000' });
    vi.spyOn(SmsEventsRepository, 'listPendingAutoEvents').mockResolvedValue([mockAutoEvent]);

    // First call succeeds in atomic claim; second concurrent call gets null
    vi.spyOn(SmsEventsRepository, 'atomicStartProcessing')
      .mockResolvedValueOnce({ ...mockAutoEvent, status: 'PROCESSING' })
      .mockResolvedValueOnce(null);

    vi.spyOn(SmsRepository, 'createMessage').mockResolvedValue({ id: 904, status: 'queued' });
    vi.spyOn(SmsRepository, 'updateMessageStatus').mockResolvedValue({ id: 904, status: 'sent' });
    vi.spyOn(SmsEventsRepository, 'markSent').mockResolvedValue({ ...mockAutoEvent, status: 'SENT' });

    const [res1, res2] = await Promise.all([
      dispatcher.dispatchPendingAutoReminders(),
      dispatcher.dispatchPendingAutoReminders()
    ]);

    expect(res1.claimed + res2.claimed).toBe(1);
    expect(res1.sent + res2.sent).toBe(1);
    expect(mockSmsService.provider.sendSms).toHaveBeenCalledTimes(1);
  });

  it('L. Invalid phone number yields 0 Payom calls and transitions event to FAILED', async () => {
    process.env.SMS_PAYMENT_REMINDER_AUTO_ENABLED = 'true';
    process.env.SMS_PAYMENT_REMINDER_DETECTOR_ENABLED = 'true';

    const mockAutoEvent = { id: 54, event_type: 'PAYMENT_REMINDER', mode: 'AUTO', status: 'AWAITING_CONFIRMATION', client_id: 13, deal_id: 13, template_code: 'PAYMENT_REMINDER' };

    const { LeadsRepository } = await import('../../leads/leads.repository.js');
    vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 13, phone: 'INVALID_123' });
    vi.spyOn(SmsEventsRepository, 'listPendingAutoEvents').mockResolvedValue([mockAutoEvent]);
    vi.spyOn(SmsEventsRepository, 'atomicStartProcessing').mockResolvedValue({ ...mockAutoEvent, status: 'PROCESSING' });
    vi.spyOn(SmsEventsRepository, 'markFailed').mockResolvedValue({ ...mockAutoEvent, status: 'FAILED' });

    const result = await dispatcher.dispatchPendingAutoReminders();

    expect(result.failed).toBe(1);
    expect(mockSmsService.provider.sendSms).not.toHaveBeenCalled();
    expect(SmsEventsRepository.markFailed).toHaveBeenCalledWith(expect.objectContaining({
      id: 54,
      failureCode: 'INVALID_PHONE'
    }));
  });

  it('M. Unresolved placeholders in preview yield 0 Payom calls and transition event to FAILED', async () => {
    process.env.SMS_PAYMENT_REMINDER_AUTO_ENABLED = 'true';
    process.env.SMS_PAYMENT_REMINDER_DETECTOR_ENABLED = 'true';

    const mockAutoEvent = { id: 55, event_type: 'PAYMENT_REMINDER', mode: 'AUTO', status: 'AWAITING_CONFIRMATION', client_id: 13, deal_id: 13, template_code: 'PAYMENT_REMINDER' };

    const { LeadsRepository } = await import('../../leads/leads.repository.js');
    vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 13, phone: '+992999333000' });
    vi.spyOn(SmsEventsRepository, 'listPendingAutoEvents').mockResolvedValue([mockAutoEvent]);
    vi.spyOn(SmsEventsRepository, 'atomicStartProcessing').mockResolvedValue({ ...mockAutoEvent, status: 'PROCESSING' });
    vi.spyOn(SmsEventsRepository, 'markFailed').mockResolvedValue({ ...mockAutoEvent, status: 'FAILED' });

    mockSmsService.previewSms.mockResolvedValueOnce({
      text: 'Здравствуйте, {{client_name}}! Напоминаем об оплате {{payment_amount}} USD.',
      characterCount: 80,
      smsSegments: 1,
      isUnicode: true
    });

    const result = await dispatcher.dispatchPendingAutoReminders();

    expect(result.failed).toBe(1);
    expect(mockSmsService.provider.sendSms).not.toHaveBeenCalled();
    expect(SmsEventsRepository.markFailed).toHaveBeenCalledWith(expect.objectContaining({
      id: 55,
      failureCode: 'UNRESOLVED_PLACEHOLDERS'
    }));
  });

  it('P. Batch limit is enforced (e.g. limit = 2 fetches and processes max 2 items)', async () => {
    process.env.SMS_PAYMENT_REMINDER_AUTO_ENABLED = 'true';
    process.env.SMS_PAYMENT_REMINDER_DETECTOR_ENABLED = 'true';

    vi.spyOn(SmsEventsRepository, 'listPendingAutoEvents').mockResolvedValue([]);

    await dispatcher.dispatchPendingAutoReminders({ batchLimit: 2 });

    expect(SmsEventsRepository.listPendingAutoEvents).toHaveBeenCalledWith({ limit: 2 });
  });
});
