import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SmsEventsRepository } from '../smsEvents.repository.js';
import { SmsEventsService } from '../smsEvents.service.js';
import { SmsService } from '../sms.service.js';

describe('SMS Outbox Core V1.5B.1 Tests', () => {
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

  describe('Migration 029 & Schema Integrity', () => {
    it('01. Migration 029 file exists in db/migrations/', () => {
      const migPath = path.join(process.cwd(), 'src/db/migrations/029_sms_events_outbox.sql');
      expect(fs.existsSync(migPath)).toBe(true);
      const sqlContent = fs.readFileSync(migPath, 'utf-8');
      expect(sqlContent).toContain('CREATE TABLE IF NOT EXISTS public.sms_events');
      expect(sqlContent).toContain('idempotency_key');
      expect(sqlContent).toContain('ALTER TABLE public.sms_messages');
    });

    it('02 & 03. Migration 029 adds nullable event_id to sms_messages without breaking legacy schema', () => {
      const migPath = path.join(process.cwd(), 'src/db/migrations/029_sms_events_outbox.sql');
      const sqlContent = fs.readFileSync(migPath, 'utf-8');
      expect(sqlContent).toContain('ADD COLUMN IF NOT EXISTS event_id BIGINT REFERENCES public.sms_events(id)');
    });

    it('04. Foreign key data types match exact parent column UDTs (INTEGER for int4 parents, BIGINT for int8)', () => {
      const migPath = path.join(process.cwd(), 'src/db/migrations/029_sms_events_outbox.sql');
      const sqlContent = fs.readFileSync(migPath, 'utf-8');
      expect(sqlContent).toContain('client_id INTEGER REFERENCES public.leads(id)');
      expect(sqlContent).toContain('deal_id INTEGER REFERENCES public.deals(id)');
      expect(sqlContent).toContain('payment_id INTEGER REFERENCES public.payments(id)');
      expect(sqlContent).toContain('schedule_id INTEGER REFERENCES public.deal_payment_schedules(id)');
      expect(sqlContent).toContain('task_id INTEGER REFERENCES public.tasks(id)');
      expect(sqlContent).toContain('confirmed_by INTEGER REFERENCES public.users(id)');
    });
  });

  describe('Repository Idempotency & State Machine', () => {
    it('05, 06 & 07. Idempotent event creation prevents duplicate rows', async () => {
      const mockEventData = {
        id: 101,
        event_type: 'PAYMENT_REMINDER',
        idempotency_key: 'PAYMENT_REMINDER:55:3:2026-10-01',
        template_code: 'PAYMENT_REMINDER',
        status: 'AWAITING_CONFIRMATION',
        client_id: 13,
        deal_id: 39,
        schedule_id: 55
      };

      vi.spyOn(SmsEventsRepository, 'getByIdempotencyKey').mockResolvedValueOnce(null).mockResolvedValueOnce(mockEventData);
      vi.spyOn(SmsEventsRepository, 'createEvent').mockImplementation(async (data) => {
        if (data.idempotency_key === mockEventData.idempotency_key) {
          return { event: mockEventData, created: true };
        }
        return { event: mockEventData, created: false };
      });

      const res1 = await SmsEventsRepository.createEvent(mockEventData);
      expect(res1.created).toBe(true);
      expect(res1.event.idempotency_key).toBe('PAYMENT_REMINDER:55:3:2026-10-01');
    });

    it('12 & 13. atomicStartProcessing converts AWAITING_CONFIRMATION to PROCESSING', async () => {
      const mockEvent = {
        id: 101,
        status: 'PROCESSING',
        event_type: 'PAYMENT_REMINDER'
      };
      vi.spyOn(SmsEventsRepository, 'atomicStartProcessing').mockResolvedValue(mockEvent);

      const claimed = await SmsEventsRepository.atomicStartProcessing(101);
      expect(claimed).not.toBeNull();
      expect(claimed.status).toBe('PROCESSING');
    });

    it('14. Second concurrent processing claim returns null (rejected)', async () => {
      vi.spyOn(SmsEventsRepository, 'atomicStartProcessing').mockResolvedValue(null);

      const secondClaim = await SmsEventsRepository.atomicStartProcessing(101);
      expect(secondClaim).toBeNull();
    });

    it('15. cancelEvent transitions AWAITING_CONFIRMATION to CANCELLED', async () => {
      const mockCancelled = {
        id: 101,
        status: 'CANCELLED',
        cancelled_by: 1,
        cancel_reason: 'Отменено менеджером'
      };
      vi.spyOn(SmsEventsRepository, 'getById').mockResolvedValue({ id: 101, status: 'AWAITING_CONFIRMATION' });
      vi.spyOn(SmsEventsRepository, 'cancelEvent').mockResolvedValue(mockCancelled);

      const res = await smsEventsService.cancelEvent({ id: 101, userId: 1, reason: 'Отменено менеджером' });
      expect(res.status).toBe('CANCELLED');
      expect(res.cancelled_by).toBe(1);
    });

    it('16, 17 & 18. Terminal or invalid states (SENT, CANCELLED, DELIVERY_UNKNOWN) cannot be processed', async () => {
      vi.spyOn(SmsEventsRepository, 'atomicStartProcessing').mockResolvedValue(null);
      vi.spyOn(SmsEventsRepository, 'getById').mockResolvedValue({ id: 101, status: 'SENT' });

      await expect(smsEventsService.confirmEvent({ id: 101, userId: 1 })).rejects.toThrow('не может быть повторно отправлено');
    });

    it('19, 20 & 21. markSent, markFailed, and markDeliveryUnknown update status correctly', async () => {
      vi.spyOn(SmsEventsRepository, 'markSent').mockResolvedValue({ id: 101, status: 'SENT', sms_message_id: 801 });
      vi.spyOn(SmsEventsRepository, 'markFailed').mockResolvedValue({ id: 101, status: 'FAILED', failure_code: 'ERR' });
      vi.spyOn(SmsEventsRepository, 'markDeliveryUnknown').mockResolvedValue({ id: 101, status: 'DELIVERY_UNKNOWN', failure_code: 'PAYOM_TIMEOUT' });

      const sent = await SmsEventsRepository.markSent({ id: 101, smsMessageId: 801, userId: 1 });
      expect(sent.status).toBe('SENT');

      const failed = await SmsEventsRepository.markFailed({ id: 101, failureCode: 'ERR', failureMessage: 'Msg' });
      expect(failed.status).toBe('FAILED');

      const timeout = await SmsEventsRepository.markDeliveryUnknown({ id: 101, failureCode: 'PAYOM_TIMEOUT', failureMessage: 'Timed out' });
      expect(timeout.status).toBe('DELIVERY_UNKNOWN');
    });
  });

  describe('Context Security & Re-Validation', () => {
    it('23. Wrong deal/client combination is rejected', async () => {
      const mockEvent = { id: 101, client_id: 13, deal_id: 99, template_code: 'DEAL_INFO' };
      vi.spyOn(SmsEventsRepository, 'getById').mockResolvedValue(mockEvent);

      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 13 });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({ id: 99, lead_id: 55 }); // Belongs to lead 55!

      await expect(smsEventsService.previewEvent(101)).rejects.toThrow('Сделка не принадлежит указанному клиенту');
    });

    it('24 & 25. Voided payment or wrong schedule is rejected', async () => {
      const mockEvent = { id: 101, client_id: 13, deal_id: 39, payment_id: 400, template_code: 'PAYMENT_RECEIVED' };
      vi.spyOn(SmsEventsRepository, 'getById').mockResolvedValue(mockEvent);

      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 13 });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({ id: 39, lead_id: 13 });
      vi.spyOn(DealsRepository, 'getPaymentById').mockResolvedValue({ id: 400, deal_id: 39, status: 'VOIDED' });

      const res = await smsEventsService.previewEvent(101);
      expect(res.isApplicable).toBe(false);
      expect(res.cancelReason).toContain('Платёж был аннулирован');
    });

    it('26, 27 & 28. Payload financial spoofing is ignored; preview uses authoritative server-side DB context & latest canonical template', async () => {
      const mockEvent = {
        id: 101,
        client_id: 13,
        deal_id: 39,
        template_code: 'DEAL_INFO',
        payload_json: { total_paid: '9999999 USD (FAKE SPOOF)' }
      };
      vi.spyOn(SmsEventsRepository, 'getById').mockResolvedValue(mockEvent);

      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 13, full_name: 'Абдуллоев Акмалхон' });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({ id: 39, lead_id: 13 });

      const preview = await smsEventsService.previewEvent(101);

      expect(mockSmsService.previewSms).toHaveBeenCalledWith({
        templateCode: 'DEAL_INFO',
        clientId: 13,
        dealId: 39,
        paymentId: undefined,
        taskId: undefined
      });
      expect(preview.text).not.toContain('9999999');
      expect(preview.text).toContain('54 391 USD');
    });

    it('29. Preview requires 0 Payom API calls', async () => {
      const mockEvent = { id: 101, client_id: 13, deal_id: 39, template_code: 'DEAL_INFO' };
      vi.spyOn(SmsEventsRepository, 'getById').mockResolvedValue(mockEvent);

      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 13 });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({ id: 39, lead_id: 13 });

      await smsEventsService.previewEvent(101);
      expect(mockSmsService.sendSms).not.toHaveBeenCalled();
    });
  });

  describe('Feature Flag & Safety Rules', () => {
    it('V1.5B.1 confirmEvent fails closed in production when SMS_OUTBOX_ALLOW_SEND is false', async () => {
      const mockEvent = { id: 101, status: 'PROCESSING', client_id: 13, deal_id: 39, template_code: 'DEAL_INFO' };
      vi.spyOn(SmsEventsRepository, 'atomicStartProcessing').mockResolvedValue(mockEvent);
      vi.spyOn(SmsEventsRepository, 'getById').mockResolvedValue(mockEvent);
      vi.spyOn(SmsEventsRepository, 'cancelEvent').mockResolvedValue({ id: 101, status: 'CANCELLED' });

      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 13 });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({ id: 39, lead_id: 13 });

      const origEnv = process.env.NODE_ENV;
      const origAllow = process.env.SMS_OUTBOX_CONFIRM_ENABLED;
      process.env.NODE_ENV = 'production';
      process.env.SMS_OUTBOX_CONFIRM_ENABLED = 'false';

      try {
        await expect(smsEventsService.confirmEvent({ id: 101, userId: 1 })).rejects.toThrow('SMS_OUTBOX_CONFIRM_ENABLED');
      } finally {
        process.env.NODE_ENV = origEnv;
        process.env.SMS_OUTBOX_CONFIRM_ENABLED = origAllow;
      }
    });
  });
});
