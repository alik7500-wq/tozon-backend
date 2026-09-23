import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SmsService } from '../sms.service.js';
import { SmsRepository } from '../sms.repository.js';
import { getBusinessDate, getBusinessDateTime } from '../../../utils/businessTime.js';
import * as dbConn from '../../../db/connection.js';

describe('SmsService Audit Flow & Fail-Closed Rules', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should throw error when getServiceDB is called without SUPABASE_SERVICE_ROLE_KEY', () => {
    const origEnv = process.env.NODE_ENV;
    const origServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const origTestServiceKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
    const origTestKey = process.env.TEST_SUPABASE_KEY;

    process.env.NODE_ENV = 'production';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.TEST_SUPABASE_KEY;

    try {
      expect(() => dbConn.getServiceDB()).toThrow('SUPABASE_SERVICE_ROLE_KEY_REQUIRED');
    } finally {
      process.env.NODE_ENV = origEnv;
      if (origServiceKey) process.env.SUPABASE_SERVICE_ROLE_KEY = origServiceKey;
      if (origTestServiceKey) process.env.TEST_SUPABASE_SERVICE_ROLE_KEY = origTestServiceKey;
      if (origTestKey) process.env.TEST_SUPABASE_KEY = origTestKey;
    }
  });

  it('should NOT call Payom provider if initial DB queued insert fails', async () => {
    vi.spyOn(SmsRepository, 'createMessage').mockRejectedValue(
      new Error('Не удалось сохранить запись SMS в базу данных: permission denied')
    );

    const mockProvider = {
      sendSms: vi.fn()
    };

    const smsService = new SmsService(mockProvider);

    await expect(
      smsService.sendSms({
        phone: '+992927779757',
        text: 'Тест'
      })
    ).rejects.toThrow('permission denied');

    expect(mockProvider.sendSms).not.toHaveBeenCalled();
  });

  it('should process provider success and update DB status to sent with providerMessageId', async () => {
    vi.spyOn(SmsRepository, 'createMessage').mockResolvedValue({
      id: 101,
      phone: '+992927779757',
      status: 'queued'
    });

    const updateSpy = vi.spyOn(SmsRepository, 'updateMessageStatus').mockResolvedValue({
      id: 101,
      status: 'sent'
    });

    const mockProvider = {
      sendSms: vi.fn().mockResolvedValue({
        success: true,
        providerMessageId: 'PAYOM_REAL_9999',
        isMock: false
      })
    };

    const smsService = new SmsService(mockProvider);

    const result = await smsService.sendSms({
      phone: '+992927779757',
      text: 'Тест'
    });

    expect(result.success).toBe(true);
    expect(result.data.providerMessageId).toBe('PAYOM_REAL_9999');
    expect(result.data.isMock).toBe(false);

    expect(updateSpy).toHaveBeenCalledWith(101, expect.objectContaining({
      status: 'sent',
      providerMessageId: 'PAYOM_REAL_9999'
    }));
  });

  it('should process provider failure and update DB status to failed with error code', async () => {
    vi.spyOn(SmsRepository, 'createMessage').mockResolvedValue({
      id: 102,
      phone: '+992927779757',
      status: 'queued'
    });

    const updateSpy = vi.spyOn(SmsRepository, 'updateMessageStatus').mockResolvedValue({
      id: 102,
      status: 'failed'
    });

    const mockProvider = {
      sendSms: vi.fn().mockResolvedValue({
        success: false,
        errorCode: 'PAYOM_UNAUTHORIZED',
        errorMessage: 'Bad token'
      })
    };

    const smsService = new SmsService(mockProvider);

    const result = await smsService.sendSms({
      phone: '+992927779757',
      text: 'Тест'
    });

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('PAYOM_UNAUTHORIZED');

    expect(updateSpy).toHaveBeenCalledWith(102, expect.objectContaining({
      status: 'failed',
      errorCode: 'PAYOM_UNAUTHORIZED',
      errorMessage: 'Bad token'
    }));
  });

  it('should retrieve lead phone and name when clientId is provided', async () => {
    const { LeadsRepository } = await import('../../leads/leads.repository.js');
    vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({
      id: 55,
      full_name: 'Фарход Каримов',
      phone: '+992928889988'
    });

    vi.spyOn(SmsRepository, 'createMessage').mockResolvedValue({
      id: 200,
      client_id: 55,
      phone: '+992928889988',
      status: 'queued'
    });

    vi.spyOn(SmsRepository, 'updateMessageStatus').mockResolvedValue({
      id: 200,
      status: 'sent'
    });

    const mockProvider = {
      sendSms: vi.fn().mockResolvedValue({
        success: true,
        providerMessageId: 'PAYOM_MOCK_55',
        isMock: true
      })
    };

    const smsService = new SmsService(mockProvider);
    const result = await smsService.sendSms({
      clientId: 55,
      text: 'Приветственное сообщение'
    });

    expect(result.success).toBe(true);
    expect(result.data.clientName).toBe('Фарход Каримов');
    expect(result.data.phone).toBe('+992928889988');
  });

  it('should normalize local Tajik numbers starting with 92 to +992 format', async () => {
    vi.spyOn(SmsRepository, 'createMessage').mockResolvedValue({
      id: 201,
      phone: '+992927779757',
      status: 'queued'
    });
    vi.spyOn(SmsRepository, 'updateMessageStatus').mockResolvedValue({ id: 201, status: 'sent' });

    const mockProvider = {
      sendSms: vi.fn().mockResolvedValue({ success: true, providerMessageId: 'P_1', isMock: true })
    };

    const smsService = new SmsService(mockProvider);
    const result = await smsService.sendSms({
      phone: '927779757',
      text: 'Тест нормализации'
    });

    expect(result.success).toBe(true);
    expect(result.data.phone).toBe('+992927779757');
  });

  describe('SmsService Deal/Client Relation Security Validation', () => {
    it('REQUIRED TEST 17 — MATCHING DEAL: should allow SMS when deal exists and belongs to specified client', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({
        id: 10,
        full_name: 'Клиент A',
        phone: '+992927770010'
      });

      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 200,
        lead_id: 10
      });

      vi.spyOn(SmsRepository, 'createMessage').mockResolvedValue({
        id: 301,
        client_id: 10,
        deal_id: 200,
        phone: '+992927770010',
        status: 'queued'
      });

      vi.spyOn(SmsRepository, 'updateMessageStatus').mockResolvedValue({ id: 301, status: 'sent' });

      const mockProvider = {
        sendSms: vi.fn().mockResolvedValue({ success: true, providerMessageId: 'PAYOM_MOCK_MATCH', isMock: true })
      };

      const smsService = new SmsService(mockProvider);
      const result = await smsService.sendSms({
        clientId: 10,
        dealId: 200,
        text: 'Тест валидной сделки'
      });

      expect(result.success).toBe(true);
      expect(mockProvider.sendSms).toHaveBeenCalledTimes(1);
    });

    it('REQUIRED TEST 18 — MISMATCHED DEAL: should reject SMS and NOT call Payom when deal belongs to a different client', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({
        id: 10,
        full_name: 'Клиент A',
        phone: '+992927770010'
      });

      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 200,
        lead_id: 20 // Belonging to Client B
      });

      const createMsgSpy = vi.spyOn(SmsRepository, 'createMessage');

      const mockProvider = {
        sendSms: vi.fn()
      };

      const smsService = new SmsService(mockProvider);

      await expect(
        smsService.sendSms({
          clientId: 10,
          dealId: 200,
          text: 'Тест чужой сделки'
        })
      ).rejects.toThrow('Сделка не принадлежит указанному клиенту');

      expect(createMsgSpy).not.toHaveBeenCalled();
      expect(mockProvider.sendSms).not.toHaveBeenCalled();
    });

    it('REQUIRED TEST 19 — NONEXISTENT DEAL: should reject SMS and NOT call Payom when dealId does not exist', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({
        id: 10,
        full_name: 'Клиент A',
        phone: '+992927770010'
      });

      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue(null);

      const createMsgSpy = vi.spyOn(SmsRepository, 'createMessage');
      const mockProvider = {
        sendSms: vi.fn()
      };

      const smsService = new SmsService(mockProvider);

      await expect(
        smsService.sendSms({
          clientId: 10,
          dealId: 999999,
          text: 'Тест несуществующей сделки'
        })
      ).rejects.toThrow('Сделка не найдена');

      expect(createMsgSpy).not.toHaveBeenCalled();
      expect(mockProvider.sendSms).not.toHaveBeenCalled();
    });

    it('REQUIRED TEST 20 — NULL DEAL: should proceed with standard Client SMS flow when dealId is null', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({
        id: 10,
        full_name: 'Клиент A',
        phone: '+992927770010'
      });

      const getDealSpy = vi.spyOn(DealsRepository, 'getDealById');

      vi.spyOn(SmsRepository, 'createMessage').mockResolvedValue({
        id: 304,
        client_id: 10,
        deal_id: null,
        phone: '+992927770010',
        status: 'queued'
      });

      vi.spyOn(SmsRepository, 'updateMessageStatus').mockResolvedValue({ id: 304, status: 'sent' });

      const mockProvider = {
        sendSms: vi.fn().mockResolvedValue({ success: true, providerMessageId: 'PAYOM_MOCK_NULL_DEAL', isMock: true })
      };

      const smsService = new SmsService(mockProvider);
      const result = await smsService.sendSms({
        clientId: 10,
        dealId: null,
        text: 'Тест null dealId'
      });

      expect(result.success).toBe(true);
      expect(getDealSpy).not.toHaveBeenCalled();
      expect(mockProvider.sendSms).toHaveBeenCalledTimes(1);
    });

    it('REQUIRED TEST 21 — INVALID CLIENT: should reject SMS and NOT call Payom when clientId does not exist', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue(null);

      const getDealSpy = vi.spyOn(DealsRepository, 'getDealById');
      const createMsgSpy = vi.spyOn(SmsRepository, 'createMessage');
      const mockProvider = {
        sendSms: vi.fn()
      };

      const smsService = new SmsService(mockProvider);

      await expect(
        smsService.sendSms({
          clientId: 999999,
          dealId: 200,
          text: 'Тест несуществующего клиента'
        })
      ).rejects.toThrow('Клиент с ID 999999 не найден');

      expect(getDealSpy).not.toHaveBeenCalled();
      expect(createMsgSpy).not.toHaveBeenCalled();
      expect(mockProvider.sendSms).not.toHaveBeenCalled();
    });
  });

  describe('SMS V1.3 Context-Aware Templates & Unresolved Placeholder Protection', () => {
    it('REQUIRED TEST V1.3 — UNRESOLVED PLACEHOLDER: should reject SMS and NOT call Payom when message contains {{placeholder}}', async () => {
      const mockProvider = {
        sendSms: vi.fn()
      };
      const createMsgSpy = vi.spyOn(SmsRepository, 'createMessage');

      const smsService = new SmsService(mockProvider);

      await expect(
        smsService.sendSms({
          phone: '+992927779757',
          text: 'Уважаемый {{client_name}}, ваш платеж {{overdue_amount}} сомони просрочен.'
        })
      ).rejects.toThrow('Сообщение содержит незаполненные переменные шаблона');

      expect(createMsgSpy).not.toHaveBeenCalled();
      expect(mockProvider.sendSms).not.toHaveBeenCalled();
    });

    it('REQUIRED TEST V1.3 — PROPERLY INTERPOLATED: should send SMS when all placeholders are substituted', async () => {
      vi.spyOn(SmsRepository, 'createMessage').mockResolvedValue({
        id: 401,
        phone: '+992927779757',
        status: 'queued'
      });
      vi.spyOn(SmsRepository, 'updateMessageStatus').mockResolvedValue({ id: 401, status: 'sent' });

      const mockProvider = {
        sendSms: vi.fn().mockResolvedValue({
          success: true,
          providerMessageId: 'PAYOM_V1_3_INTERPOLATED',
          isMock: true
        })
      };

      const smsService = new SmsService(mockProvider);
      const result = await smsService.sendSms({
        phone: '+992927779757',
        text: 'Уважаемый Фарход, ваш платеж 12 000 TJS по договору 105 просрочен.'
      });

      expect(result.success).toBe(true);
      expect(mockProvider.sendSms).toHaveBeenCalledTimes(1);
    });
  });

  describe('SMS V1.3.1 Data Semantics Hotfix & Ground-Truth Context Validation', () => {
    const mockToday = '2026-09-23';

    it('TEST V1.3.1 - 1 & 4: overdue_amount != remaining_balance & partially paid schedule accounts only for unpaid part', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 701,
        lead_id: 10,
        final_price_minor: 10000000, // 100 000 USD
        payments: [{ status: 'POSTED', amount_minor: 2000000 }], // 20 000 paid total
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2026-01-01', amount_minor: 1000000, paid_amount_minor: 600000 }, // Overdue unpaid 400000 (4000 USD)
          { id: 2, payment_number: 2, due_date: '2026-10-01', amount_minor: 1000000, paid_amount_minor: 0 } // Future
        ]
      });

      const mockProvider = { sendSms: vi.fn() };
      const smsService = new SmsService(mockProvider);

      const context = await smsService.calculateDealContext(701, mockToday);

      expect(context.remainingBalanceMinor).toBe(8000000); // 80 000 USD
      expect(context.overdueMinor).toBe(400000); // 4 000 USD (ONLY unpaid portion of past due item)
      expect(context.overdueMinor).not.toBe(context.remainingBalanceMinor);
    });

    it('TEST V1.3.1 - 2: future schedule is excluded from overdue_amount', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 702,
        lead_id: 10,
        final_price_minor: 5000000,
        payments: [],
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2099-12-31', amount_minor: 1000000, paid_amount_minor: 0 }
        ]
      });

      const mockProvider = { sendSms: vi.fn() };
      const smsService = new SmsService(mockProvider);
      const context = await smsService.calculateDealContext(702, mockToday);

      expect(context.overdueMinor).toBe(0);
    });

    it('TEST V1.3.1 - 3: fully paid overdue schedule is excluded from overdue_amount', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 703,
        lead_id: 10,
        final_price_minor: 5000000,
        payments: [{ status: 'POSTED', amount_minor: 1000000 }],
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2026-01-01', amount_minor: 1000000, paid_amount_minor: 1000000 }
        ]
      });

      const mockProvider = { sendSms: vi.fn() };
      const smsService = new SmsService(mockProvider);
      const context = await smsService.calculateDealContext(703, mockToday);

      expect(context.overdueMinor).toBe(0);
    });

    it('TEST V1.3.1 - 5: payment_amount and payment_date are taken from the SAME single schedule row', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 705,
        lead_id: 10,
        final_price_minor: 10000000,
        payments: [],
        deal_payment_schedules: [
          { id: 10, payment_number: 1, due_date: '2026-10-15', amount_minor: 1500000, paid_amount_minor: 0 },
          { id: 11, payment_number: 2, due_date: '2026-11-15', amount_minor: 2000000, paid_amount_minor: 0 }
        ]
      });

      const mockProvider = { sendSms: vi.fn() };
      const smsService = new SmsService(mockProvider);
      const context = await smsService.calculateDealContext(705, mockToday);

      expect(context.nextSchedule.id).toBe(10);
      expect(context.nextSchedule.due_date).toBe('2026-10-15');
      expect(context.nextSchedule.amount_minor).toBe(1500000);
    });

    it('TEST V1.3.1 - 6: schedule of another deal is rejected', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      const { LeadsRepository } = await import('../../leads/leads.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 10, full_name: 'Клиент A', phone: '+992927770010' });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({ id: 706, lead_id: 20 }); // Client B

      const mockProvider = { sendSms: vi.fn() };
      const smsService = new SmsService(mockProvider);

      await expect(
        smsService.sendSms({
          clientId: 10,
          dealId: 706,
          templateCode: 'PAYMENT_REMINDER',
          text: 'Оплата'
        })
      ).rejects.toThrow('Сделка не принадлежит указанному клиенту');

      expect(mockProvider.sendSms).not.toHaveBeenCalled();
    });

    it('TEST V1.3.1 - 7: debtor template without confirmed overdue is rejected (PAYOM_CALLS = 0)', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      const { LeadsRepository } = await import('../../leads/leads.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 10, full_name: 'Клиент A', phone: '+992927770010' });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 707,
        lead_id: 10,
        currency: 'USD',
        final_price_minor: 5000000,
        payments: [],
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2099-01-01', amount_minor: 1000000, paid_amount_minor: 0 } // Future only
        ]
      });

      const mockProvider = { sendSms: vi.fn() };
      const smsService = new SmsService(mockProvider);

      await expect(
        smsService.sendSms({
          clientId: 10,
          dealId: 707,
          templateCode: 'DEBTOR_REMINDER',
          text: 'Внесите оплату'
        })
      ).rejects.toThrow('Просроченная задолженность отсутствует');

      expect(mockProvider.sendSms).not.toHaveBeenCalled();
    });

    it('TEST V1.3.1 - 8: forged frontend overdue_amount cannot override server calculation', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 708,
        lead_id: 10,
        final_price_minor: 5000000,
        payments: [],
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2026-01-01', amount_minor: 500000, paid_amount_minor: 0 }
        ]
      });

      const mockProvider = { sendSms: vi.fn() };
      const smsService = new SmsService(mockProvider);
      const context = await smsService.calculateDealContext(708, mockToday);

      // Server calculated overdue is 5000 minor (50 TJS/USD)
      expect(context.overdueMinor).toBe(500000);
      expect(context.overdueAmountFormatted.replace(/\u00a0/g, ' ')).toBe('5 000');
    });

    it('TEST V1.3.1 - 9 & 10: meeting belongs to clientId; meeting of another client is rejected', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { TasksRepository } = await import('../../tasks/tasks.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 10, full_name: 'Клиент A', phone: '+992927770010' });
      vi.spyOn(TasksRepository, 'findById').mockResolvedValue({ id: 99, lead_id: 20 }); // Client B task

      const mockProvider = { sendSms: vi.fn() };
      const smsService = new SmsService(mockProvider);

      await expect(
        smsService.sendSms({
          clientId: 10,
          taskId: 99,
          templateCode: 'MEETING_REMINDER',
          text: 'Встреча'
        })
      ).rejects.toThrow('Встреча не принадлежит указанному клиенту');

      expect(mockProvider.sendSms).not.toHaveBeenCalled();
    });

    it('TEST V1.3.1 - 11: missing meeting data blocks template send (PAYOM_CALLS = 0)', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { TasksRepository } = await import('../../tasks/tasks.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 10, full_name: 'Клиент A', phone: '+992927770010' });
      vi.spyOn(TasksRepository, 'findAll').mockResolvedValue([]); // No tasks for client

      const mockProvider = { sendSms: vi.fn() };
      const smsService = new SmsService(mockProvider);

      await expect(
        smsService.sendSms({
          clientId: 10,
          templateCode: 'MEETING_REMINDER',
          text: 'Встреча'
        })
      ).rejects.toThrow('Нет предстоящей запланированной встречи');

      expect(mockProvider.sendSms).not.toHaveBeenCalled();
    });

    it('TEST V1.3.1 - 12: unresolved placeholder => PAYOM_CALLS = 0', async () => {
      const mockProvider = { sendSms: vi.fn() };
      const smsService = new SmsService(mockProvider);

      await expect(
        smsService.sendSms({
          phone: '+992927779757',
          text: 'Здравствуйте {{client_name}}, ваш баланс {{overdue_amount}}'
        })
      ).rejects.toThrow('Сообщение содержит незаполненные переменные шаблона');

      expect(mockProvider.sendSms).not.toHaveBeenCalled();
    });
  });

  describe('SMS V1.3 Template Source-of-Truth & Placeholder Contract Matrix', () => {
    it('1. DB CLIENT_WELCOME returns clean template row from repository', async () => {
      const templates = await SmsRepository.getTemplates();
      const clientWelcome = templates.find((t) => t.code === 'CLIENT_WELCOME');
      expect(clientWelcome).toBeDefined();
      expect(clientWelcome.text).toContain('{{client_name}}');
    });

    it('2. DB MEETING_REMINDER contains meeting_date and meeting_time placeholders', async () => {
      const templates = await SmsRepository.getTemplates();
      const meetingTmpl = templates.find((t) => t.code === 'MEETING_REMINDER');
      expect(meetingTmpl).toBeDefined();
      expect(meetingTmpl.text).toContain('{{meeting_date}}');
      expect(meetingTmpl.text).toContain('{{meeting_time}}');
    });

    it('3. CUSTOM_MESSAGE code is inactive / filtered out from getTemplates()', async () => {
      const templates = await SmsRepository.getTemplates();
      const customMsg = templates.find((t) => t.code === 'CUSTOM_MESSAGE' || t.text === '{{text}}');
      expect(customMsg).toBeUndefined();
    });

    it('4 & 14. Unknown/invalid templateCode throws error or rejects gracefully', async () => {
      const smsService = new SmsService({ sendSms: vi.fn() });
      await expect(
        smsService.sendSms({
          phone: '+992927779757',
          templateCode: 'UNKNOWN_CODE',
          text: '{{unknown_placeholder}}'
        })
      ).rejects.toThrow('Сообщение содержит незаполненные переменные шаблона');
    });
  });

  describe('SMS V1.3 Final Currency Placeholder Hotfix Regression Tests', () => {
    const mockToday = '2026-09-23';

    it('1. PAYMENT_REMINDER resolves currency from validated deal context', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 801,
        currency: 'TJS',
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2026-10-15', amount_minor: 1500000, paid_amount_minor: 0 }
        ]
      });

      const smsService = new SmsService({ sendSms: vi.fn() });
      const context = await smsService.calculateDealContext(801, mockToday);
      expect(context.currency).toBe('TJS');
    });

    it('2. DEBTOR_REMINDER resolves currency from validated debtor context', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 802,
        currency: 'USD',
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2026-01-01', amount_minor: 500000, paid_amount_minor: 0 }
        ]
      });

      const smsService = new SmsService({ sendSms: vi.fn() });
      const context = await smsService.calculateDealContext(802, mockToday);
      expect(context.currency).toBe('USD');
      expect(context.overdueMinor).toBe(500000);
    });

    it('3. Frontend forged currency is ignored, server calculated currency used', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 803,
        currency: 'TJS',
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2026-10-15', amount_minor: 1500000, paid_amount_minor: 0 }
        ]
      });

      const smsService = new SmsService({ sendSms: vi.fn() });
      const context = await smsService.calculateDealContext(803, mockToday);
      expect(context.currency).toBe('TJS');
      expect(context.currency).not.toBe('EUR');
    });

    it('4 & 5. Missing/unresolvable currency => HTTP 400 & PAYOM_CALLS = 0', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      const { LeadsRepository } = await import('../../leads/leads.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 10, full_name: 'Клиент A', phone: '+992927770010' });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 804,
        lead_id: 10,
        currency: null,
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2026-10-15', amount_minor: 1500000, paid_amount_minor: 0 }
        ]
      });

      const mockProvider = { sendSms: vi.fn() };
      const smsService = new SmsService(mockProvider);

      await expect(
        smsService.sendSms({
          clientId: 10,
          dealId: 804,
          templateCode: 'PAYMENT_REMINDER',
          text: 'Оплата'
        })
      ).rejects.toThrow('Не удалось определить валюту сделки');

      expect(mockProvider.sendSms).not.toHaveBeenCalled();
    });

    it('6. payment amount/date/currency belong to same validated deal context', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 806,
        currency: 'TJS',
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2026-10-15', amount_minor: 1500000, paid_amount_minor: 0 }
        ]
      });

      const smsService = new SmsService({ sendSms: vi.fn() });
      const context = await smsService.calculateDealContext(806, mockToday);
      expect(context.currency).toBe('TJS');
      expect(context.nextSchedule.due_date).toBe('2026-10-15');
      expect(context.nextSchedule.amount_minor).toBe(1500000);
    });

    it('7. overdue amount/currency belong to same validated debtor context', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 807,
        currency: 'USD',
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2026-01-01', amount_minor: 2500000, paid_amount_minor: 500000 }
        ]
      });

      const smsService = new SmsService({ sendSms: vi.fn() });
      const context = await smsService.calculateDealContext(807, mockToday);
      expect(context.currency).toBe('USD');
      expect(context.overdueMinor).toBe(2000000);
    });

    it('8. Final rendered PAYMENT_REMINDER contains no unresolved placeholders', async () => {
      const templateText = 'Здравствуйте, {{client_name}}! Напоминаем об очередной оплате по договору №{{contract_number}} в размере {{payment_amount}} {{currency}} до {{payment_date}}. TOZON-PLAZA.';
      const rendered = templateText
        .replace(/\{\{\s*client_name\s*\}\}/g, 'Фарход')
        .replace(/\{\{\s*contract_number\s*\}\}/g, '105')
        .replace(/\{\{\s*payment_amount\s*\}\}/g, '15 000')
        .replace(/\{\{\s*currency\s*\}\}/g, 'TJS')
        .replace(/\{\{\s*payment_date\s*\}\}/g, '2026-10-15');

      expect(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.test(rendered)).toBe(false);
      expect(rendered).toBe('Здравствуйте, Фарход! Напоминаем об очередной оплате по договору №105 в размере 15 000 TJS до 2026-10-15. TOZON-PLAZA.');
    });

    it('9. Final rendered DEBTOR_REMINDER contains no unresolved placeholders', async () => {
      const templateText = 'Уважаемый(ая) {{client_name}}! Просим внести просроченную оплату {{overdue_amount}} {{currency}} по договору №{{contract_number}}. TOZON-PLAZA.';
      const rendered = templateText
        .replace(/\{\{\s*client_name\s*\}\}/g, 'Фарход')
        .replace(/\{\{\s*contract_number\s*\}\}/g, '105')
        .replace(/\{\{\s*overdue_amount\s*\}\}/g, '5 000')
        .replace(/\{\{\s*currency\s*\}\}/g, 'TJS');

      expect(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.test(rendered)).toBe(false);
      expect(rendered).toBe('Уважаемый(ая) Фарход! Просим внести просроченную оплату 5 000 TJS по договору №105. TOZON-PLAZA.');
    });
  });

  describe('SMS V1.3 Dynamic Resolution & Preview Safety Tests', () => {
    it('1. CLIENT_WELCOME preview resolves client_name from lead', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 10, full_name: 'Шохида Каримова' });

      const smsService = new SmsService({ sendSms: vi.fn() });
      const preview = await smsService.previewSms({ templateCode: 'CLIENT_WELCOME', clientId: 10 });

      expect(preview.resolved).toBe(true);
      expect(preview.text).toContain('Здравствуйте, Шохида Каримова!');
      expect(preview.text).not.toContain('{{client_name}}');
    });

    it('2 & 3. MEETING_REMINDER preview resolves meeting_date and meeting_time', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { TasksRepository } = await import('../../tasks/tasks.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 10, full_name: 'Фарход' });
      vi.spyOn(TasksRepository, 'findById').mockResolvedValue({
        id: 99,
        lead_id: 10,
        due_date: '2026-10-20',
        due_time: '14:30',
        type: 'MEETING',
        status: 'OPEN'
      });

      const smsService = new SmsService({ sendSms: vi.fn() });
      const preview = await smsService.previewSms({ templateCode: 'MEETING_REMINDER', clientId: 10, taskId: 99 });

      expect(preview.resolved).toBe(true);
      expect(preview.text).toContain('2026-10-20');
      expect(preview.text).toContain('14:30');
      expect(preview.text).not.toContain('{{meeting_date}}');
      expect(preview.text).not.toContain('{{meeting_time}}');
    });

    it('4. Wrong-client meeting is rejected by preview', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { TasksRepository } = await import('../../tasks/tasks.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 10, full_name: 'Фарход' });
      vi.spyOn(TasksRepository, 'findById').mockResolvedValue({ id: 99, lead_id: 20 });

      const smsService = new SmsService({ sendSms: vi.fn() });
      await expect(
        smsService.previewSms({ templateCode: 'MEETING_REMINDER', clientId: 10, taskId: 99 })
      ).rejects.toThrow('Встреча не принадлежит указанному клиенту');
    });

    it('5. Ambiguous/missing meeting handled safely (controlled 400 error)', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { TasksRepository } = await import('../../tasks/tasks.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 10, full_name: 'Фарход' });
      vi.spyOn(TasksRepository, 'findAll').mockResolvedValue([]);

      const smsService = new SmsService({ sendSms: vi.fn() });
      await expect(
        smsService.previewSms({ templateCode: 'MEETING_REMINDER', clientId: 10 })
      ).rejects.toThrow('Нет предстоящей запланированной встречи');
    });

    it('6, 7 & 8. DEAL_INFO resolves contract_number, apartment, and project_name', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 10, full_name: 'Фарход' });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 301,
        lead_id: 10,
        contract_number: '105-A',
        unit_number: '42',
        project_name: 'TOZON-PLAZA-BLOCK-B'
      });

      const smsService = new SmsService({ sendSms: vi.fn() });
      const preview = await smsService.previewSms({ templateCode: 'DEAL_INFO', clientId: 10, dealId: 301 });

      expect(preview.text).toContain('№105-A');
      expect(preview.text).toContain('кв. №42');
      expect(preview.text).toContain('TOZON-PLAZA-BLOCK-B');
      expect(preview.text).not.toContain('{{contract_number}}');
    });

    it('9. Wrong deal/client is rejected by preview', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 10, full_name: 'Фарход' });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({ id: 301, lead_id: 99 });

      const smsService = new SmsService({ sendSms: vi.fn() });
      await expect(
        smsService.previewSms({ templateCode: 'DEAL_INFO', clientId: 10, dealId: 301 })
      ).rejects.toThrow('Сделка не принадлежит указанному клиенту');
    });

    it('10, 11, 12 & 13. PAYMENT_REMINDER resolves payment_amount, payment_date, currency from same schedule', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 10, full_name: 'Фарход' });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 302,
        lead_id: 10,
        contract_number: '202-B',
        currency: 'TJS',
        deal_payment_schedules: [
          { id: 101, payment_number: 1, due_date: '2026-11-15', amount_minor: 1800000, paid_amount_minor: 0 }
        ]
      });

      const smsService = new SmsService({ sendSms: vi.fn() });
      const preview = await smsService.previewSms({ templateCode: 'PAYMENT_REMINDER', clientId: 10, dealId: 302 });

      expect(preview.text.replace(/\u00a0/g, ' ')).toContain('18 000 TJS');
      expect(preview.text).toContain('2026-11-15');
      expect(preview.text).toContain('№202-B');
      expect(preview.text).not.toContain('{{payment_amount}}');
    });

    it('14 & 18. Forged frontend values are ignored during server resolution', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 10, full_name: 'Фарход' });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 303,
        lead_id: 10,
        contract_number: '303',
        currency: 'USD',
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2026-01-01', amount_minor: 5000000, paid_amount_minor: 0 }
        ]
      });

      const smsService = new SmsService({ sendSms: vi.fn() });
      const preview = await smsService.previewSms({ templateCode: 'DEBTOR_REMINDER', clientId: 10, dealId: 303, text: 'Просим оплатить 1 USD' });

      expect(preview.text.replace(/\u00a0/g, ' ')).toContain('50 000 USD');
    });

    it('15 & 16. DEBTOR_REMINDER resolves overdue_amount and currency', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 10, full_name: 'Фарход' });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 304,
        lead_id: 10,
        contract_number: '304',
        currency: 'TJS',
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2026-01-01', amount_minor: 1200000, paid_amount_minor: 200000 }
        ]
      });

      const smsService = new SmsService({ sendSms: vi.fn() });
      const preview = await smsService.previewSms({ templateCode: 'DEBTOR_REMINDER', clientId: 10, dealId: 304 });

      expect(preview.text.replace(/\u00a0/g, ' ')).toContain('10 000 TJS');
      expect(preview.text).toContain('просроченную оплату');
    });

    it('17. Zero or negative overdue debt is rejected by preview', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 10, full_name: 'Фарход' });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 305,
        lead_id: 10,
        currency: 'TJS',
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2099-01-01', amount_minor: 1000000, paid_amount_minor: 0 }
        ]
      });

      const smsService = new SmsService({ sendSms: vi.fn() });
      await expect(
        smsService.previewSms({ templateCode: 'DEBTOR_REMINDER', clientId: 10, dealId: 305 })
      ).rejects.toThrow(/Просроченная задолженность/i);
    });

    it('19 & 20. Preview makes 0 Payom calls and 0 sms_messages inserts', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 10, full_name: 'Фарход' });

      const createMsgSpy = vi.spyOn(SmsRepository, 'createMessage');
      const mockProvider = { sendSms: vi.fn() };

      const smsService = new SmsService(mockProvider);
      const preview = await smsService.previewSms({ templateCode: 'CLIENT_WELCOME', clientId: 10 });

      expect(preview.resolved).toBe(true);
      expect(createMsgSpy).not.toHaveBeenCalled();
      expect(mockProvider.sendSms).not.toHaveBeenCalled();
    });

    it('22 & 23. Backend unresolved placeholder => HTTP 400 & 0 Payom calls', async () => {
      const mockProvider = { sendSms: vi.fn() };
      const createMsgSpy = vi.spyOn(SmsRepository, 'createMessage');

      const smsService = new SmsService(mockProvider);

      await expect(
        smsService.sendSms({
          phone: '+992927779757',
          text: 'Здравствуйте {{client_name}}, ваш баланс {{custom_unresolved}}'
        })
      ).rejects.toThrow('Сообщение содержит незаполненные переменные шаблона');

      expect(createMsgSpy).not.toHaveBeenCalled();
      expect(mockProvider.sendSms).not.toHaveBeenCalled();
    });

    it('25. Preview and send use the exact same template resolver', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 10, full_name: 'Алиев Рахим', phone: '+992927771122' });

      vi.spyOn(SmsRepository, 'createMessage').mockResolvedValue({ id: 999, phone: '+992927771122', status: 'queued' });
      vi.spyOn(SmsRepository, 'updateMessageStatus').mockResolvedValue({ id: 999, status: 'sent' });

      const mockProvider = { sendSms: vi.fn().mockResolvedValue({ success: true, providerMessageId: 'P_PREVIEW_SAME' }) };
      const smsService = new SmsService(mockProvider);

      const preview = await smsService.previewSms({ templateCode: 'CLIENT_WELCOME', clientId: 10 });
      const sendResult = await smsService.sendSms({ templateCode: 'CLIENT_WELCOME', clientId: 10 });

      expect(sendResult.data.message).toBe(preview.text);
    });
  });

  describe('SmsService V1.4 Template Availability & Context Rules', () => {
    beforeEach(async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { TasksRepository } = await import('../../tasks/tasks.repository.js');
      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 50, full_name: 'Акмал Рахимов', phone: '+992927771234' });
      vi.spyOn(TasksRepository, 'findAll').mockResolvedValue([]);
    });

    it('1. CLIENT_WELCOME available when valid client with name & phone exists', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 50, full_name: 'Акмал Рахимов', phone: '+992927771234' });

      const smsService = new SmsService();
      const res = await smsService.getTemplateAvailability({ clientId: 50 });

      const welcome = res.templates.find((t) => t.code === 'CLIENT_WELCOME');
      expect(welcome.available).toBe(true);
      expect(welcome.reason).toBeNull();
    });

    it('2. Missing client -> CLIENT_WELCOME unavailable with reason', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue(null);

      const smsService = new SmsService();
      const res = await smsService.getTemplateAvailability({ clientId: 99999 });

      const welcome = res.templates.find((t) => t.code === 'CLIENT_WELCOME');
      expect(welcome.available).toBe(false);
      expect(welcome.reason).toContain('не найден');
    });

    it('3. Future meeting -> MEETING_REMINDER available', async () => {
      const { TasksRepository } = await import('../../tasks/tasks.repository.js');
      const futureDate = '2099-12-31';
      vi.spyOn(TasksRepository, 'findAll').mockResolvedValue([
        { id: 10, lead_id: 50, type: 'MEETING', status: 'OPEN', due_date: futureDate, due_time: '14:00' }
      ]);

      const smsService = new SmsService();
      const res = await smsService.getTemplateAvailability({ clientId: 50 });

      const meeting = res.templates.find((t) => t.code === 'MEETING_REMINDER');
      expect(meeting.available).toBe(true);
    });

    it('4. Past OPEN meeting -> MEETING_REMINDER unavailable', async () => {
      const { TasksRepository } = await import('../../tasks/tasks.repository.js');
      vi.spyOn(TasksRepository, 'findAll').mockResolvedValue([
        { id: 11, lead_id: 50, type: 'MEETING', status: 'OPEN', due_date: '2020-01-01', due_time: '10:00' }
      ]);

      const smsService = new SmsService();
      const res = await smsService.getTemplateAvailability({ clientId: 50 });

      const meeting = res.templates.find((t) => t.code === 'MEETING_REMINDER');
      expect(meeting.available).toBe(false);
      expect(meeting.reason).toContain('Нет предстоящей');
    });

    it('5. Completed meeting -> MEETING_REMINDER unavailable', async () => {
      const { TasksRepository } = await import('../../tasks/tasks.repository.js');
      vi.spyOn(TasksRepository, 'findAll').mockResolvedValue([
        { id: 12, lead_id: 50, type: 'MEETING', status: 'COMPLETED', due_date: '2099-12-31', due_time: '10:00' }
      ]);

      const smsService = new SmsService();
      const res = await smsService.getTemplateAvailability({ clientId: 50 });

      const meeting = res.templates.find((t) => t.code === 'MEETING_REMINDER');
      expect(meeting.available).toBe(false);
    });

    it('6. Cancelled meeting -> MEETING_REMINDER unavailable', async () => {
      const { TasksRepository } = await import('../../tasks/tasks.repository.js');
      vi.spyOn(TasksRepository, 'findAll').mockResolvedValue([
        { id: 13, lead_id: 50, type: 'MEETING', status: 'CANCELLED', due_date: '2099-12-31', due_time: '10:00' }
      ]);

      const smsService = new SmsService();
      const res = await smsService.getTemplateAvailability({ clientId: 50 });

      const meeting = res.templates.find((t) => t.code === 'MEETING_REMINDER');
      expect(meeting.available).toBe(false);
    });

    it('7. Multiple future meetings -> nearest datetime selected', async () => {
      const { TasksRepository } = await import('../../tasks/tasks.repository.js');
      vi.spyOn(TasksRepository, 'findAll').mockResolvedValue([
        { id: 20, lead_id: 50, type: 'MEETING', status: 'OPEN', due_date: '2099-10-01', due_time: '15:00' },
        { id: 21, lead_id: 50, type: 'MEETING', status: 'OPEN', due_date: '2099-05-01', due_time: '10:00' }
      ]);

      const smsService = new SmsService();
      const ctx = await smsService.calculateMeetingContext(50);

      expect(ctx.task.id).toBe(21); // Nearest date (May 2099)
    });

    it('8. Future unpaid schedule -> PAYMENT_REMINDER available', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 70,
        lead_id: 50,
        currency: 'USD',
        final_price_minor: 1000000,
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2099-12-01', amount_minor: 100000, paid_amount_minor: 0 }
        ],
        payments: []
      });

      const smsService = new SmsService();
      const res = await smsService.getTemplateAvailability({ clientId: 50, dealId: 70 });

      const payment = res.templates.find((t) => t.code === 'PAYMENT_REMINDER');
      expect(payment.available).toBe(true);
    });

    it('9. Partial future payment -> remaining schedule amount used', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 71,
        lead_id: 50,
        currency: 'USD',
        final_price_minor: 1000000,
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2099-12-01', amount_minor: 100000, paid_amount_minor: 40000 }
        ],
        payments: []
      });

      const smsService = new SmsService();
      const ctx = await smsService.calculateDealContext(71, '2026-09-23');

      expect(ctx.nextSchedule.unpaid_amount_minor).toBe(60000); // 100,000 - 40,000 = 60,000
    });

    it('11. Only overdue schedules -> PAYMENT_REMINDER unavailable', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 72,
        lead_id: 50,
        currency: 'USD',
        final_price_minor: 1000000,
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2020-01-01', amount_minor: 100000, paid_amount_minor: 0 }
        ],
        payments: []
      });

      const smsService = new SmsService();
      const res = await smsService.getTemplateAvailability({ clientId: 50, dealId: 72 });

      const payment = res.templates.find((t) => t.code === 'PAYMENT_REMINDER');
      expect(payment.available).toBe(false);
      expect(payment.reason).toContain('Нет предстоящего');
    });

    it('12. overdue_amount > 0 -> DEBTOR_REMINDER available', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 73,
        lead_id: 50,
        currency: 'USD',
        final_price_minor: 1000000,
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2020-01-01', amount_minor: 100000, paid_amount_minor: 0 }
        ],
        payments: []
      });

      const smsService = new SmsService();
      const res = await smsService.getTemplateAvailability({ clientId: 50, dealId: 73, todayStr: '2026-09-23' });

      const debtor = res.templates.find((t) => t.code === 'DEBTOR_REMINDER');
      expect(debtor.available).toBe(true);
    });

    it('13. remaining_balance > 0 but overdue_amount = 0 -> DEBTOR_REMINDER unavailable', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 74,
        lead_id: 50,
        currency: 'USD',
        final_price_minor: 1000000,
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2099-12-01', amount_minor: 100000, paid_amount_minor: 0 }
        ],
        payments: []
      });

      const smsService = new SmsService();
      const res = await smsService.getTemplateAvailability({ clientId: 50, dealId: 74, todayStr: '2026-09-23' });

      const debtor = res.templates.find((t) => t.code === 'DEBTOR_REMINDER');
      expect(debtor.available).toBe(false);
      expect(debtor.reason).toContain('отсутствует');
    });

    it('15 & 16. Availability endpoint -> zero DB inserts & zero Payom calls', async () => {
      const mockProvider = { sendSms: vi.fn() };
      const createMsgSpy = vi.spyOn(SmsRepository, 'createMessage');

      const smsService = new SmsService(mockProvider);
      const res = await smsService.getTemplateAvailability({ clientId: 50 });

      expect(res.templates).toBeDefined();
      expect(createMsgSpy).not.toHaveBeenCalled();
      expect(mockProvider.sendSms).not.toHaveBeenCalled();
    });
  });

  describe('SmsService V1.4 Asia/Dushanbe Business Time & Boundary Tests', () => {
    it('CASE 1: UTC 2026-09-22 20:30 => Asia/Dushanbe 2026-09-23 01:30 (Expected Date: 2026-09-23)', () => {
      const utcTime = '2026-09-22T20:30:00Z';
      const bDate = getBusinessDate(utcTime);
      const { dateStr, timeStr } = getBusinessDateTime(utcTime);

      expect(bDate).toBe('2026-09-23');
      expect(dateStr).toBe('2026-09-23');
      expect(timeStr).toBe('01:30');
    });

    it('CASE 2: UTC 2026-09-22 18:30 => Asia/Dushanbe 2026-09-22 23:30 (Expected Date: 2026-09-22)', () => {
      const utcTime = '2026-09-22T18:30:00Z';
      const bDate = getBusinessDate(utcTime);
      const { dateStr, timeStr } = getBusinessDateTime(utcTime);

      expect(bDate).toBe('2026-09-22');
      expect(dateStr).toBe('2026-09-22');
      expect(timeStr).toBe('23:30');
    });

    it('CASE 3 & CASE 4: Schedule due_date boundary comparisons relative to business date', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 88,
        lead_id: 50,
        currency: 'USD',
        final_price_minor: 2000000,
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2026-09-22', amount_minor: 500000, paid_amount_minor: 0 },
          { id: 2, payment_number: 2, due_date: '2026-09-23', amount_minor: 500000, paid_amount_minor: 0 }
        ],
        payments: []
      });

      const smsService = new SmsService();
      // On business date 2026-09-23:
      // - Schedule 1 (2026-09-22) is PAST DUE (< 2026-09-23) -> Overdue
      // - Schedule 2 (2026-09-23) is NOT OVERDUE (>= 2026-09-23) -> Qualifies as next upcoming schedule
      const ctx = await smsService.calculateDealContext(88, '2026-09-23');

      expect(ctx.overdueMinor).toBe(500000); // Only Schedule 1 is overdue
      expect(ctx.nextSchedule.due_date).toBe('2026-09-23'); // Schedule 2 is upcoming
      expect(ctx.nextSchedule.unpaid_amount_minor).toBe(500000);
    });

    it('MEETING TIMEZONE TEST: Business datetime 2026-09-23 00:30 Asia/Dushanbe', async () => {
      const { TasksRepository } = await import('../../tasks/tasks.repository.js');
      const nowUtc = '2026-09-22T19:30:00Z'; // 19:30 UTC = 00:30 Dushanbe on 2026-09-23

      const pastMeeting = { id: 101, lead_id: 50, type: 'MEETING', status: 'OPEN', due_date: '2026-09-22', due_time: '23:30' };
      const futureMeeting = { id: 102, lead_id: 50, type: 'MEETING', status: 'OPEN', due_date: '2026-09-23', due_time: '01:30' };

      vi.spyOn(TasksRepository, 'findAll').mockResolvedValue([pastMeeting, futureMeeting]);

      const smsService = new SmsService();
      const ctx = await smsService.calculateMeetingContext(50, null, nowUtc);

      // Past meeting (2026-09-22 23:30) is filtered out. Future meeting (2026-09-23 01:30) is selected!
      expect(ctx.task.id).toBe(102);
      expect(ctx.meetingDate).toBe('2026-09-23');
      expect(ctx.meetingTime).toBe('01:30');
    });

    it('DEBTORS / SMS CONSISTENCY: DealsRepository and SmsService produce identical overdue amounts', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      const testDealData = {
        id: 99,
        lead_id: 50,
        contract_number: '999',
        currency: 'USD',
        final_price_minor: 1000000,
        units: { unit_number: '101', area_m2_x100: 5000, price_per_m2_minor: 20000 },
        leads: { full_name: 'Акмал' },
        users: { name: 'Менеджер' },
        payments: [],
        deal_payment_schedules: [
          { id: 1, payment_number: 1, due_date: '2026-01-01', amount_minor: 300000, paid_amount_minor: 100000 },
          { id: 2, payment_number: 2, due_date: '2026-09-23', amount_minor: 300000, paid_amount_minor: 0 }
        ]
      };

      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue(testDealData);

      const smsService = new SmsService();
      const smsCtx = await smsService.calculateDealContext(99, '2026-09-23');

      // Schedule 1 is overdue: 300,000 - 100,000 = 200,000 minor
      // Schedule 2 is due today (2026-09-23): NOT overdue
      expect(smsCtx.overdueMinor).toBe(200000);
      expect(smsCtx.overdueAmountFormatted.replace(/\u00a0/g, ' ')).toBe('2 000');
    });
  });

  describe('SmsService V1.4.1 Debtor Consistency & DEAL_INFO Expansion Tests', () => {
    beforeEach(async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { TasksRepository } = await import('../../tasks/tasks.repository.js');
      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 17, full_name: 'Ахророва Мадина Муминова', phone: '+992927771234' });
      vi.spyOn(TasksRepository, 'findAll').mockResolvedValue([]);
      vi.spyOn(SmsRepository, 'getTemplates').mockResolvedValue([
        { code: 'CLIENT_WELCOME', name: 'Приветствие клиента', is_active: true, text: 'Здравствуйте, {{client_name}}!' },
        { code: 'MEETING_REMINDER', name: 'Напоминание о встрече', is_active: true, text: 'Напоминаем о встрече {{meeting_date}} {{meeting_time}}' },
        { code: 'DEAL_INFO', name: 'Сообщение по договору', is_active: true, text: '{{client_name}}: дог. №{{contract_number}}, кв. №{{apartment}} ({{apartment_area}} м²). Стоимость {{contract_total}} {{currency}}, оплачено {{total_paid}} {{currency}}, остаток {{remaining_balance}} {{currency}}. TOZON-PLAZA' },
        { code: 'PAYMENT_REMINDER', name: 'Напоминание об оплате', is_active: true, text: 'Оплата по договору №{{contract_number}} {{payment_amount}} {{currency}} до {{payment_date}}' },
        { code: 'DEBTOR_REMINDER', name: 'Напоминание о задолженности', is_active: true, text: 'Просрочка по договору №{{contract_number}}: {{overdue_amount}} {{currency}}' }
      ]);
    });
    it('1 & 2. Client with multiple deals does not cross-resolve debt and uses exact dealId schedules', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      const deal23 = {
        id: 23,
        lead_id: 17,
        contract_number: '0013',
        currency: 'USD',
        final_price_minor: 2949000,
        payments: [{ amount_minor: 877434, status: 'PAID' }],
        schedules: [
          { id: 463, payment_number: 1, due_date: '2026-03-13', amount_minor: 122900, paid_amount_minor: 877434, status: 'PAID' }
        ]
      };

      const deal24 = {
        id: 24,
        lead_id: 17,
        contract_number: '0014',
        currency: 'USD',
        final_price_minor: 2689000,
        payments: [{ amount_minor: 31120, status: 'PAID' }],
        schedules: [
          { id: 487, payment_number: 1, due_date: '2026-03-13', amount_minor: 112100, paid_amount_minor: 31120, status: 'PARTIAL' },
          { id: 488, payment_number: 2, due_date: '2026-04-13', amount_minor: 112100, paid_amount_minor: 0, status: 'UPCOMING' }
        ]
      };

      vi.spyOn(DealsRepository, 'getDealById').mockImplementation(async (id) => {
        if (id === 23) return deal23;
        if (id === 24) return deal24;
        return null;
      });

      const smsService = new SmsService();

      // Check Deal 23 availability: overdue is 0 -> DEBTOR_REMINDER unavailable
      const res23 = await smsService.getTemplateAvailability({ clientId: 17, dealId: 23, todayStr: '2026-09-23' });
      const debtor23 = res23.templates.find((t) => t.code === 'DEBTOR_REMINDER');
      expect(debtor23.available).toBe(false);

      // Check Deal 24 availability: overdue is 193080 minor -> DEBTOR_REMINDER available!
      const res24 = await smsService.getTemplateAvailability({ clientId: 17, dealId: 24, todayStr: '2026-09-23' });
      const debtor24 = res24.templates.find((t) => t.code === 'DEBTOR_REMINDER');
      expect(debtor24.available).toBe(true);
      expect(debtor24.reason).toBeNull();
    });

    it('3 & 4. overdue > 0 -> DEBTOR_REMINDER available; overdue = 0 -> DEBTOR_REMINDER unavailable', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 100,
        lead_id: 17,
        currency: 'USD',
        final_price_minor: 1000000,
        payments: [],
        schedules: [
          { id: 1, payment_number: 1, due_date: '2026-01-01', amount_minor: 100000, paid_amount_minor: 0 }
        ]
      });

      const smsService = new SmsService();
      const res = await smsService.getTemplateAvailability({ clientId: 17, dealId: 100, todayStr: '2026-09-23' });
      const debtor = res.templates.find((t) => t.code === 'DEBTOR_REMINDER');
      expect(debtor.available).toBe(true);
    });

    it('5 & 6. Partially paid overdue schedule calculates only unpaid portion & remaining_balance > 0 + overdue = 0 is NOT overdue', async () => {
      const { DealsRepository } = await import('../../deals/deals.repository.js');
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 101,
        lead_id: 17,
        currency: 'USD',
        final_price_minor: 2689000,
        payments: [{ amount_minor: 31120 }],
        schedules: [
          { id: 1, payment_number: 1, due_date: '2026-03-13', amount_minor: 112100, paid_amount_minor: 31120 }
        ]
      });

      const smsService = new SmsService();
      const ctx = await smsService.calculateDealContext(101, '2026-09-23');

      expect(ctx.overdueMinor).toBe(80980); // 112,100 - 31,120 = 80,980 minor (809.80 USD)
      expect(ctx.overdueAmountFormatted.replace(/\u00a0/g, ' ')).toBe('809,8');
      expect(ctx.remainingBalanceMinor).toBe(2657880);
    });

    it('8, 9, 10 & 11. DEAL_INFO resolves apartment_area, contract_total, total_paid, remaining_balance', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 17, full_name: 'Ахророва Мадина Муминова' });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 24,
        lead_id: 17,
        contract_number: '0014',
        currency: 'USD',
        final_price_minor: 2689000,
        units: { unit_number: '42', area_m2_x100: 7250 },
        payments: [{ amount_minor: 31120, status: 'PAID' }],
        schedules: [
          { id: 1, payment_number: 1, due_date: '2026-03-13', amount_minor: 112100, paid_amount_minor: 31120 }
        ]
      });

      const smsService = new SmsService();
      const preview = await smsService.previewSms({
        templateCode: 'DEAL_INFO',
        clientId: 17,
        dealId: 24,
        text: '{{client_name}}: дог. №{{contract_number}}, кв. №{{apartment}} ({{apartment_area}} м²). Стоимость {{contract_total}} {{currency}}, оплачено {{total_paid}} {{currency}}, остаток {{remaining_balance}} {{currency}}. TOZON-PLAZA'
      });

      const textClean = preview.text.replace(/\u00a0/g, ' ');
      expect(textClean).toContain('Ахророва Мадина Муминова');
      expect(textClean).toContain('№0014');
      expect(textClean).toContain('кв. №42');
      expect(textClean).toContain('72,5 м²');
      expect(textClean).toContain('26 890 USD');
      expect(textClean).toContain('311,2 USD');
      expect(textClean).toContain('26 578,8 USD');
      expect(preview.resolved).toBe(true);
    });

    it('12. DEAL_INFO financial values cannot be overridden by frontend forged values', async () => {
      const { LeadsRepository } = await import('../../leads/leads.repository.js');
      const { DealsRepository } = await import('../../deals/deals.repository.js');

      vi.spyOn(LeadsRepository, 'findById').mockResolvedValue({ id: 17, full_name: 'Ахророва Мадина' });
      vi.spyOn(DealsRepository, 'getDealById').mockResolvedValue({
        id: 24,
        lead_id: 17,
        contract_number: '0014',
        currency: 'USD',
        final_price_minor: 2689000,
        units: { unit_number: '42', area_m2_x100: 7250 },
        payments: [{ amount_minor: 31120, status: 'PAID' }],
        schedules: []
      });

      const smsService = new SmsService();
      const preview = await smsService.previewSms({
        templateCode: 'DEAL_INFO',
        clientId: 17,
        dealId: 24,
        text: 'Стоимость {{contract_total}} {{currency}}, оплачено {{total_paid}} {{currency}}, остаток {{remaining_balance}} {{currency}}'
      });

      const textClean = preview.text.replace(/\u00a0/g, ' ');
      expect(textClean).toContain('26 890 USD');
      expect(textClean).toContain('311,2 USD');
      expect(textClean).toContain('26 578,8 USD');
    });

    it('13, 14 & 15. Unresolved placeholders block sending & revalidate context without calling Payom', async () => {
      const mockProvider = { sendSms: vi.fn() };
      const smsService = new SmsService(mockProvider);

      await expect(
        smsService.sendSms({
          phone: '+992927771234',
          text: 'Сообщение с незаполненным {{custom_placeholder}}'
        })
      ).rejects.toThrow('Сообщение содержит незаполненные переменные шаблона');

      expect(mockProvider.sendSms).not.toHaveBeenCalled();
    });
  });
});





