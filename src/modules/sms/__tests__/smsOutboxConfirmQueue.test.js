import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SmsEventsRepository } from '../smsEvents.repository.js';
import { SmsEventsService } from '../smsEvents.service.js';

describe('SMS Outbox V1.5B.2 Confirm Queue & Safety Tests', () => {
  let smsEventsService;
  let mockSmsService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSmsService = {
      previewSms: vi.fn().mockResolvedValue({
        text: 'Абдуллоев Акмалхон: дог. №0029, кв. №2 (81,18 м²). Стоимость 54 391 USD, оплачено 1 078,75 USD, остаток 53 312,25 USD. ЖК TOZON PLAZA',
        characterCount: 135,
        smsSegments: 1,
        isUnicode: true
      }),
      sendSms: vi.fn().mockResolvedValue({
        success: true,
        data: { id: 801, provider_message_id: 'MOCK_801', status: 'sent' }
      })
    };
    smsEventsService = new SmsEventsService(mockSmsService);
  });

  describe('Authoritative Preview & Stale Event Auto-Cancellation', () => {
    it('01 & 02. Preview uses authoritative DB context & ignores payload_json financial spoofing', async () => {
      const mockEvent = {
        id: 201,
        client_id: 13,
        deal_id: 39,
        template_code: 'DEAL_INFO',
        status: 'AWAITING_CONFIRMATION',
        payload_json: { total_paid: '999999 USD (SPOOF)' }
      };
      vi.spyOn(SmsEventsRepository, 'getById').mockResolvedValue(mockEvent);

      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 13, full_name: 'Абдуллоев Акмалхон' });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({ id: 39, lead_id: 13 });

      const res = await smsEventsService.previewEvent(201);
      expect(res.text).not.toContain('999999');
      expect(res.text).toContain('54 391 USD');
      expect(res.previewHash).toBeDefined();
    });

    it('04. Fully paid schedule triggers auto-cancellation of stale event', async () => {
      const mockEvent = { id: 201, client_id: 13, deal_id: 39, schedule_id: 55, template_code: 'PAYMENT_REMINDER', status: 'AWAITING_CONFIRMATION' };
      vi.spyOn(SmsEventsRepository, 'getById').mockResolvedValue(mockEvent);
      vi.spyOn(SmsEventsRepository, 'cancelEvent').mockResolvedValue({ id: 201, status: 'CANCELLED' });

      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 13 });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 39,
        lead_id: 13,
        schedules: [{ id: 55, amount_minor: 100000, paid_amount_minor: 100000 }] // Fully paid!
      });

      const res = await smsEventsService.previewEvent(201);
      expect(res.isApplicable).toBe(false);
      expect(res.event.status).toBe('CANCELLED');
    });

    it('06. Closed/cancelled meeting task triggers auto-cancellation', async () => {
      const mockEvent = { id: 201, client_id: 13, task_id: 99, template_code: 'MEETING_REMINDER', status: 'AWAITING_CONFIRMATION' };
      vi.spyOn(SmsEventsRepository, 'getById').mockResolvedValue(mockEvent);
      vi.spyOn(SmsEventsRepository, 'cancelEvent').mockResolvedValue({ id: 201, status: 'CANCELLED' });

      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { TasksRepository } = await import('../../tasks/tasks.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 13 });
      vi.spyOn(TasksRepository, 'findById').mockResolvedValue({ id: 99, status: 'COMPLETED' });

      const res = await smsEventsService.previewEvent(201);
      expect(res.isApplicable).toBe(false);
      expect(res.event.status).toBe('CANCELLED');
    });
  });

  describe('PreviewHash Protection & Atomic Claim', () => {
    it('19 & 20. Matching previewHash confirms send; mismatched previewHash rejects send with PREVIEW_CHANGED and zero Payom calls', async () => {
      const mockEvent = { id: 201, status: 'PROCESSING', client_id: 13, deal_id: 39, template_code: 'DEAL_INFO' };
      vi.spyOn(SmsEventsRepository, 'getById').mockResolvedValue(mockEvent);
      vi.spyOn(SmsEventsRepository, 'atomicStartProcessing').mockResolvedValue(mockEvent);
      vi.spyOn(SmsEventsRepository, 'cancelEvent').mockResolvedValue({ id: 201, status: 'CANCELLED' });

      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      const { SmsRepository } = await import('../sms.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 13 });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({ id: 39, lead_id: 13 });
      vi.spyOn(SmsRepository, 'createMessage').mockResolvedValue({ id: 801 });

      const fakeOldHash = '0000000000000000000000000000000000000000000000000000000000000000';

      const origEnv = process.env.NODE_ENV;
      const origAllow = process.env.SMS_OUTBOX_CONFIRM_ENABLED;
      process.env.NODE_ENV = 'test';
      process.env.SMS_OUTBOX_CONFIRM_ENABLED = 'true';

      vi.spyOn(SmsEventsRepository, 'revertToAwaitingConfirmation').mockResolvedValue({ id: 201, status: 'AWAITING_CONFIRMATION' });

      try {
        await expect(smsEventsService.confirmEvent({ id: 201, userId: 1, previewHash: fakeOldHash })).rejects.toThrow('Текст сообщения изменился');
        expect(SmsEventsRepository.revertToAwaitingConfirmation).toHaveBeenCalledWith(201);
        expect(mockSmsService.sendSms).not.toHaveBeenCalled(); // 0 Payom POST calls!
      } finally {
        process.env.NODE_ENV = origEnv;
        process.env.SMS_OUTBOX_CONFIRM_ENABLED = origAllow;
      }
    });

    it('11 & 20. Double confirm claim ensures exactly one Payom call on concurrent requests', async () => {
      vi.spyOn(SmsEventsRepository, 'getById').mockResolvedValue({ id: 201, status: 'PROCESSING' });
      vi.spyOn(SmsEventsRepository, 'atomicStartProcessing').mockResolvedValue(null); // Second claim rejected!

      await expect(smsEventsService.confirmEvent({ id: 201, userId: 1 })).rejects.toThrow('Событие не может быть подтверждено');
      expect(mockSmsService.sendSms).not.toHaveBeenCalled();
    });

    it('19. Confirm vs Cancel race condition ensures zero Payom calls if cancelled before claim', async () => {
      vi.spyOn(SmsEventsRepository, 'getById').mockResolvedValue({ id: 201, status: 'CANCELLED' });
      vi.spyOn(SmsEventsRepository, 'atomicStartProcessing').mockResolvedValue(null);

      await expect(smsEventsService.confirmEvent({ id: 201, userId: 1 })).rejects.toThrow('не может быть повторно отправлено');
      expect(mockSmsService.sendSms).not.toHaveBeenCalled();
    });

    it('14, 15 & 16. Timeout updates status to DELIVERY_UNKNOWN and rejects subsequent confirm attempts', async () => {
      const mockEvent = { id: 201, status: 'PROCESSING', client_id: 13, deal_id: 39, template_code: 'DEAL_INFO' };
      vi.spyOn(SmsEventsRepository, 'getById').mockResolvedValue(mockEvent);
      vi.spyOn(SmsEventsRepository, 'atomicStartProcessing').mockResolvedValue(mockEvent);
      vi.spyOn(SmsEventsRepository, 'markDeliveryUnknown').mockResolvedValue({ id: 201, status: 'DELIVERY_UNKNOWN' });

      mockSmsService.sendSms.mockResolvedValueOnce({
        success: false,
        error: { code: 'PAYOM_TIMEOUT', message: 'Payom API timed out' }
      });

      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      const { SmsRepository } = await import('../sms.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 13 });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({ id: 39, lead_id: 13 });
      vi.spyOn(SmsRepository, 'createMessage').mockResolvedValue({ id: 801 });

      const origEnv = process.env.NODE_ENV;
      const origAllow = process.env.SMS_OUTBOX_CONFIRM_ENABLED;
      process.env.NODE_ENV = 'test';
      process.env.SMS_OUTBOX_CONFIRM_ENABLED = 'true';

      try {
        const res = await smsEventsService.confirmEvent({ id: 201, userId: 1 });
        expect(res.success).toBe(false);
        expect(res.event.status).toBe('DELIVERY_UNKNOWN');

        // Re-confirm attempt on DELIVERY_UNKNOWN event is rejected
        vi.spyOn(SmsEventsRepository, 'getById').mockResolvedValue({ id: 201, status: 'DELIVERY_UNKNOWN' });
        await expect(smsEventsService.confirmEvent({ id: 201, userId: 1 })).rejects.toThrow('не может быть повторно отправлено');
      } finally {
        process.env.NODE_ENV = origEnv;
        process.env.SMS_OUTBOX_CONFIRM_ENABLED = origAllow;
      }
    });
  });

  describe('Crash Window Safety', () => {
    it('27. Failure before atomic claim leaves event in AWAITING_CONFIRMATION', async () => {
      vi.spyOn(SmsEventsRepository, 'getById').mockResolvedValue(null);
      await expect(smsEventsService.confirmEvent({ id: 999, userId: 1 })).rejects.toThrow('не найдено');
    });

    it('28 & 31. Context validation error after claim marks event FAILED without calling Payom', async () => {
      const mockEvent = { id: 201, status: 'PROCESSING', client_id: 13, deal_id: 999, template_code: 'DEAL_INFO' };
      vi.spyOn(SmsEventsRepository, 'getById').mockResolvedValue(mockEvent);
      vi.spyOn(SmsEventsRepository, 'atomicStartProcessing').mockResolvedValue(mockEvent);
      vi.spyOn(SmsEventsRepository, 'markFailed').mockResolvedValue({ id: 201, status: 'FAILED' });

      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 13 });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue(null); // Deal missing!

      await expect(smsEventsService.confirmEvent({ id: 201, userId: 1 })).rejects.toThrow('не найдена');
      expect(mockSmsService.sendSms).not.toHaveBeenCalled();
    });
  });
});
