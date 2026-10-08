import { smsTemplateFixtures } from './smsTemplates.fixture.js';
import { SmsSettingsRepository } from '../smsSettings.repository.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SmsEventsService } from '../smsEvents.service.js';
import { SmsService } from '../sms.service.js';
import { SmsEventsRepository } from '../smsEvents.repository.js';
import { SmsRepository } from '../sms.repository.js';
import { LeadsRepository } from '../../leads/leads.repository.js';
import { DealsRepository } from '../../deals/deals.repository.js';
import { AppError } from '../../../shared/errors/errorHandler.js';

describe('V1.5F.4 Outbox State Machine Safety Hotfix Tests', () => {
  let mockProvider;
  let smsService;
  let smsEventsService;
  let eventsDb;
  let messagesDb;
  let nextEventId;
  let nextMessageId;

  beforeEach(() => {
    vi.spyOn(SmsRepository,'getTemplates').mockResolvedValue(smsTemplateFixtures);
    vi.spyOn(SmsSettingsRepository,'getRule').mockResolvedValue({enabled:true,mode:'INHERIT',offset_days:3,template_code:'PAYMENT_REMINDER'});
    vi.spyOn(SmsSettingsRepository,'daily').mockResolvedValue(0);
    eventsDb = new Map();
    messagesDb = new Map();
    nextEventId = 100;
    nextMessageId = 500;

    mockProvider = {
      sendSms: vi.fn().mockResolvedValue({
        success: true,
        providerMessageId: 'payom-mock-id-999',
        isMock: true
      })
    };

    smsService = new SmsService(mockProvider);
    smsEventsService = new SmsEventsService(smsService);

    process.env.NODE_ENV = 'test';
    process.env.SMS_OUTBOX_CONFIRM_ENABLED = 'true';
    process.env.ALLOW_SMS_REPOSITORY_MOCK_FALLBACK = 'true';

    // Mock LeadsRepository & DealsRepository
    vi.spyOn(LeadsRepository, 'findById').mockImplementation(async (id) => ({
      id: Number(id),
      full_name: 'Иванов Иван Иванович',
      phone: '+992900000001'
    }));

    vi.spyOn(DealsRepository, 'getDealById').mockImplementation(async (id) => ({
      id: Number(id),
      lead_id: 7,
      contract_number: '0002',
      final_price_minor: 100000,
      currency: 'USD',
      schedules: [
        { id: 248, payment_number: 1, due_date: '2028-10-03', amount_minor: 85300, paid_amount_minor: 0, paymentAmountFormatted: '853' }
      ]
    }));

    // Mock SmsRepository
    vi.spyOn(SmsRepository, 'createMessage').mockImplementation(async (payload) => {
      const id = nextMessageId++;
      const record = {
        id,
        client_id: payload.clientId,
        deal_id: payload.dealId,
        payment_id: payload.paymentId,
        event_id: payload.eventId,
        phone: payload.phone,
        message: payload.message,
        provider: payload.provider || 'PAYOM',
        sender_name: payload.senderName || 'TOZON-PLAZA',
        status: payload.status || 'queued',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      messagesDb.set(id, record);
      return record;
    });

    vi.spyOn(SmsRepository, 'getById').mockImplementation(async (id) => {
      return messagesDb.get(Number(id)) || null;
    });

    vi.spyOn(SmsRepository, 'getMessagesByEventId').mockImplementation(async (eventId) => {
      const result = [];
      for (const msg of messagesDb.values()) {
        if (Number(msg.event_id) === Number(eventId)) {
          result.push(msg);
        }
      }
      return result;
    });

    vi.spyOn(SmsRepository, 'updateMessageStatus').mockImplementation(async (id, updates) => {
      const record = messagesDb.get(Number(id));
      if (!record) return null;
      if (updates.status) record.status = updates.status;
      if (updates.phone) record.phone = updates.phone;
      if (updates.message) record.message = updates.message;
      if (updates.providerMessageId) record.provider_message_id = updates.providerMessageId;
      if (updates.errorCode) record.error_code = updates.errorCode;
      if (updates.errorMessage) record.error_message = updates.errorMessage;
      record.updated_at = new Date().toISOString();
      return record;
    });

    // Mock SmsEventsRepository
    vi.spyOn(SmsEventsRepository, 'getById').mockImplementation(async (id) => {
      return eventsDb.get(Number(id)) || null;
    });

    vi.spyOn(SmsEventsRepository, 'atomicStartProcessing').mockImplementation(async (id) => {
      const ev = eventsDb.get(Number(id));
      if (!ev || ev.status !== 'AWAITING_CONFIRMATION') return null;
      ev.status = 'PROCESSING';
      ev.updated_at = new Date().toISOString();
      return ev;
    });

    vi.spyOn(SmsEventsRepository, 'revertToAwaitingConfirmation').mockImplementation(async (id) => {
      const ev = eventsDb.get(Number(id));
      if (!ev) return null;
      ev.status = 'AWAITING_CONFIRMATION';
      ev.updated_at = new Date().toISOString();
      return ev;
    });

    vi.spyOn(SmsEventsRepository, 'markSent').mockImplementation(async ({ id, userId }) => {
      const ev = eventsDb.get(Number(id));
      if (!ev) return null;
      ev.status = 'SENT';
      ev.confirmed_by = userId;
      ev.confirmed_at = new Date().toISOString();
      ev.updated_at = new Date().toISOString();
      return ev;
    });

    vi.spyOn(SmsEventsRepository, 'markFailed').mockImplementation(async ({ id, failureCode, failureMessage }) => {
      const ev = eventsDb.get(Number(id));
      if (!ev) return null;
      ev.status = 'FAILED';
      ev.failure_code = failureCode;
      ev.failure_message = failureMessage;
      ev.updated_at = new Date().toISOString();
      return ev;
    });

    vi.spyOn(SmsEventsRepository, 'markDeliveryUnknown').mockImplementation(async ({ id, failureCode, failureMessage }) => {
      const ev = eventsDb.get(Number(id));
      if (!ev) return null;
      ev.status = 'DELIVERY_UNKNOWN';
      ev.failure_code = failureCode;
      ev.failure_message = failureMessage;
      ev.updated_at = new Date().toISOString();
      return ev;
    });
  });

  function createTestEvent(status = 'AWAITING_CONFIRMATION') {
    const id = nextEventId++;
    const ev = {
      id,
      event_type: 'PAYMENT_REMINDER',
      idempotency_key: `PAYMENT_REMINDER:248:3:2026-10-03:${id}`,
      mode: 'CONFIRM',
      status,
      client_id: 7,
      deal_id: 12,
      schedule_id: 248,
      template_code: 'PAYMENT_REMINDER',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    eventsDb.set(id, ev);
    return ev;
  }

  // Test A
  it('Test A: Outbox confirm creates EXACTLY ONE sms_messages row and transitions to SENT', async () => {
    const ev = createTestEvent('AWAITING_CONFIRMATION');

    const result = await smsEventsService.confirmEvent({ id: ev.id, userId: 1 });

    expect(result.success).toBe(true);
    expect(mockProvider.sendSms).toHaveBeenCalledTimes(1);

    // Verify EXACTLY ONE sms_message row was created
    const linkedMessages = await SmsRepository.getMessagesByEventId(ev.id);
    expect(linkedMessages.length).toBe(1);

    const msg = linkedMessages[0];
    expect(msg.status).toBe('sent');
    expect(msg.phone).toBe('+992900000001');
    expect(msg.provider_message_id).toBe('payom-mock-id-999');

    const updatedEv = await SmsEventsRepository.getById(ev.id);
    expect(updatedEv.status).toBe('SENT');
  });

  // Test B
  it('Test B: Provider definitive failure creates 1 sms_message row (status failed) and sets event FAILED', async () => {
    const ev = createTestEvent('AWAITING_CONFIRMATION');

    mockProvider.sendSms.mockResolvedValueOnce({
      success: false,
      errorCode: 'INVALID_PHONE',
      errorMessage: 'Invalid phone number'
    });

    const result = await smsEventsService.confirmEvent({ id: ev.id, userId: 1 });

    expect(result.success).toBe(false);
    expect(mockProvider.sendSms).toHaveBeenCalledTimes(1);

    const linkedMessages = await SmsRepository.getMessagesByEventId(ev.id);
    expect(linkedMessages.length).toBe(1);

    const msg = linkedMessages[0];
    expect(msg.status).toBe('failed');
    expect(msg.error_code).toBe('INVALID_PHONE');

    const updatedEv = await SmsEventsRepository.getById(ev.id);
    expect(updatedEv.status).toBe('FAILED');
  });

  // Test C
  it('Test C: Provider timeout/ambiguous creates 1 message row (delivery_unknown), sets event DELIVERY_UNKNOWN without retry', async () => {
    const ev = createTestEvent('AWAITING_CONFIRMATION');

    mockProvider.sendSms.mockResolvedValueOnce({
      success: false,
      errorCode: 'PAYOM_TIMEOUT',
      errorMessage: 'Gateway Timeout 504'
    });

    const result = await smsEventsService.confirmEvent({ id: ev.id, userId: 1 });

    expect(result.success).toBe(false);
    expect(mockProvider.sendSms).toHaveBeenCalledTimes(1);

    const linkedMessages = await SmsRepository.getMessagesByEventId(ev.id);
    expect(linkedMessages.length).toBe(1);

    const updatedEv = await SmsEventsRepository.getById(ev.id);
    expect(updatedEv.status).toBe('DELIVERY_UNKNOWN');
  });

  // Test D
  it('Test D: Confirm request on PROCESSING event fails closed with HTTP 409 and 0 Payom calls', async () => {
    const ev = createTestEvent('PROCESSING');

    await expect(smsEventsService.confirmEvent({ id: ev.id, userId: 1 }))
      .rejects
      .toThrow(AppError);

    try {
      await smsEventsService.confirmEvent({ id: ev.id, userId: 1 });
    } catch (err) {
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('EVENT_ALREADY_PROCESSING');
    }

    expect(mockProvider.sendSms).toHaveBeenCalledTimes(0);

    const updatedEv = await SmsEventsRepository.getById(ev.id);
    expect(updatedEv.status).toBe('PROCESSING'); // Status unchanged, NOT reverted to AWAITING_CONFIRMATION
  });

  // Test E
  it('Test E: Server-side reconciliation of PROCESSING event with linked sent message transitions to SENT with 0 Payom calls', async () => {
    const ev = createTestEvent('PROCESSING');

    // Create linked sent message in DB (simulating legacy/orphaned state)
    await SmsRepository.createMessage({
      clientId: 7,
      dealId: 12,
      eventId: ev.id,
      phone: '+992900000001',
      message: 'Test message',
      status: 'sent'
    });

    const recon = await smsEventsService.reconcileEventState(ev.id, 1);

    expect(recon.success).toBe(true);
    expect(recon.reconciled).toBe(true);
    expect(recon.targetStatus).toBe('SENT');
    expect(mockProvider.sendSms).toHaveBeenCalledTimes(0);

    const updatedEv = await SmsEventsRepository.getById(ev.id);
    expect(updatedEv.status).toBe('SENT');
  });

  // Test F
  it('Test F: Server-side reconciliation of PROCESSING event with linked delivery_unknown message transitions to DELIVERY_UNKNOWN', async () => {
    const ev = createTestEvent('PROCESSING');

    await SmsRepository.createMessage({
      clientId: 7,
      dealId: 12,
      eventId: ev.id,
      phone: '+992900000001',
      message: 'Test message',
      status: 'delivery_unknown'
    });

    const recon = await smsEventsService.reconcileEventState(ev.id, 1);

    expect(recon.success).toBe(true);
    expect(recon.reconciled).toBe(true);
    expect(recon.targetStatus).toBe('DELIVERY_UNKNOWN');
    expect(mockProvider.sendSms).toHaveBeenCalledTimes(0);

    const updatedEv = await SmsEventsRepository.getById(ev.id);
    expect(updatedEv.status).toBe('DELIVERY_UNKNOWN');
  });

  // Test G
  it('Test G: Reconciliation repeated twice is idempotent and makes 0 Payom calls', async () => {
    const ev = createTestEvent('PROCESSING');

    await SmsRepository.createMessage({
      clientId: 7,
      dealId: 12,
      eventId: ev.id,
      phone: '+992900000001',
      message: 'Test message',
      status: 'sent'
    });

    const recon1 = await smsEventsService.reconcileEventState(ev.id, 1);
    expect(recon1.reconciled).toBe(true);

    const recon2 = await smsEventsService.reconcileEventState(ev.id, 1);
    expect(recon2.reconciled).toBe(false);
    expect(recon2.reason).toContain('уже находится в конечном статусе');

    expect(mockProvider.sendSms).toHaveBeenCalledTimes(0);
  });

  // Test H
  it('Test H: Normal manual SMS outside outbox creates 1 message row and calls provider normally', async () => {
    const result = await smsService.sendSms({
      clientId: 7,
      text: 'Здравствуйте! Ручное сообщение вне outbox.',
      userId: 1
    });

    expect(result.success).toBe(true);
    expect(mockProvider.sendSms).toHaveBeenCalledTimes(1);

    expect(messagesDb.size).toBe(1);
    const msg = Array.from(messagesDb.values())[0];
    expect(msg.status).toBe('sent');
    expect(msg.phone).toBe('+992900000001');
  });
});
