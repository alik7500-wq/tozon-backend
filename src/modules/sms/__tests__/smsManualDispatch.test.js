import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../sms.repository.js', () => ({
  SmsRepository: {
    createMessage: vi.fn(),
    updateMessageStatus: vi.fn(),
    getById: vi.fn()
  }
}));
vi.mock('../../notifications/notifications.service.js', () => ({
  NotificationsService: { notifySmsFailed: vi.fn() }
}));

import { SmsService } from '../sms.service.js';
import { SmsRepository } from '../sms.repository.js';

describe('manual bilingual SMS dispatch with a fake provider (no Payom requests)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    SmsRepository.createMessage.mockResolvedValue({ id: 101 });
    SmsRepository.updateMessageStatus.mockResolvedValue({ id: 101 });
  });

  for (const language of ['tj', 'ru']) {
    it('records the selected ' + language + ' language and sends only through fake provider', async () => {
      const fakeProvider = { sendSms: vi.fn().mockResolvedValue({ success: true, isMock: true, providerMessageId: 'fake-1' }) };
      const service = new SmsService(fakeProvider);
      const text = language === 'tj' ? 'Салом, ин паёми санҷишӣ аст.' : 'Здравствуйте, это тестовое сообщение.';
      const result = await service.sendSms({ phone: '+992927000000', text, language });
      expect(result.success).toBe(true);
      expect(result.data.isMock).toBe(true);
      expect(SmsRepository.createMessage).toHaveBeenCalledWith(expect.objectContaining({ language, message: text }));
      expect(fakeProvider.sendSms).toHaveBeenCalledOnce();
      expect(fakeProvider.sendSms).toHaveBeenCalledWith(expect.objectContaining({ text }));
    });
  }

  it('does not call provider when saving the SMS attempt fails', async () => {
    SmsRepository.createMessage.mockRejectedValueOnce(new Error('DB unavailable'));
    const fakeProvider = { sendSms: vi.fn() };
    const service = new SmsService(fakeProvider);
    await expect(service.sendSms({ phone: '+992927000000', text: 'Салом', language: 'tj' })).rejects.toThrow('DB unavailable');
    expect(fakeProvider.sendSms).not.toHaveBeenCalled();
  });

  it('does not send when a pre-created Outbox attempt cannot be found', async () => {
    SmsRepository.getById.mockResolvedValueOnce(null);
    const fakeProvider = { sendSms: vi.fn() };
    const service = new SmsService(fakeProvider);
    await expect(service.sendSms({ phone: '+992927000000', text: 'Салом', language: 'tj', existingMessageId: 200 })).rejects.toThrow('не найдена');
    expect(fakeProvider.sendSms).not.toHaveBeenCalled();
  });
});
