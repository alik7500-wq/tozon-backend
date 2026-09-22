import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SmsService } from '../sms.service.js';
import { SmsRepository } from '../sms.repository.js';
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
});
