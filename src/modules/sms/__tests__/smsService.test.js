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
});
