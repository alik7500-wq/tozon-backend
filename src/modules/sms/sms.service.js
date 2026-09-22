import { PayomSmsProvider } from './sms.provider.js';
import { SmsRepository } from './sms.repository.js';
import { LeadsRepository } from '../leads/leads.repository.js';
import { DealsRepository } from '../deals/deals.repository.js';
import { normalizePhoneNumber } from '../../utils/phoneNormalizer.js';
import { parseOptionalBigInt } from '../../utils/idNormalizer.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export class SmsService {
  constructor(smsProvider = new PayomSmsProvider()) {
    this.provider = smsProvider;
  }

  /**
   * Main method to send SMS safely with guaranteed audit trail and fail-closed rules.
   */
  async sendSms({
    clientId = null,
    phone = null,
    text = null,
    templateCode = null,
    dealId = null,
    contractId = null,
    userId = null,
    senderName = 'TOZON-PLAZA'
  }) {
    const normClientId = parseOptionalBigInt(clientId);
    const normDealId = parseOptionalBigInt(dealId);

    let targetPhone = phone;
    let clientName = null;

    // 1. If clientId is provided, retrieve lead data if available
    if (normClientId) {
      const lead = await LeadsRepository.findById(normClientId);
      if (lead) {
        clientName = lead.full_name;
        if (!targetPhone) {
          targetPhone = lead.phone || lead.secondary_phone;
        }
      } else if (!targetPhone) {
        throw new AppError(`Клиент с ID ${normClientId} не найден`, 404);
      }
    }

    // 2. If dealId is provided, validate deal existence and relation to client
    if (normDealId) {
      const deal = await DealsRepository.getDealById(normDealId);
      if (!deal) {
        throw new AppError('Сделка не найдена', 404);
      }
      const dealLeadId = parseOptionalBigInt(deal.lead_id);
      if (normClientId && dealLeadId !== normClientId) {
        throw new AppError('Сделка не принадлежит указанному клиенту', 400);
      }
    }

    if (!targetPhone) {
      throw new AppError('Телефонный номер получателя не указан', 400);
    }

    // 2. Normalize phone number
    const normResult = normalizePhoneNumber(targetPhone);
    if (!normResult.isValid) {
      throw new AppError(normResult.error || 'Некорректный телефонный номер', 400);
    }

    const normalizedPhone = normResult.normalized;

    // 3. Validate text content
    if (!text || typeof text !== 'string' || !text.trim()) {
      throw new AppError('Текст SMS сообщения не может быть пустым', 400);
    }

    const cleanedText = text.trim();

    // 4. Create initial queued record in DB FIRST (Audit Trail)
    // If DB persistence fails, exception will be thrown and Payom will NOT be called.
    const dbRecord = await SmsRepository.createMessage({
      clientId,
      dealId,
      contractId,
      phone: normalizedPhone,
      message: cleanedText,
      provider: 'PAYOM',
      senderName,
      status: 'queued',
      createdBy: userId
    });

    if (!dbRecord || !dbRecord.id) {
      throw new AppError('Не удалось зарегистрировать сообщение в базе данных (Audit Trail error)', 500);
    }

    // 5. Update status to 'sending'
    await SmsRepository.updateMessageStatus(dbRecord.id, { status: 'sending' });

    // 6. Call SMS Provider (Only reached if DB persistence succeeded)
    const providerResult = await this.provider.sendSms({
      phone: normalizedPhone,
      text: cleanedText,
      senderName
    });

    const now = new Date().toISOString();

    // 7. Process provider outcome & update DB record
    if (providerResult.success) {
      await SmsRepository.updateMessageStatus(dbRecord.id, {
        status: 'sent',
        providerMessageId: providerResult.providerMessageId,
        sentAt: now
      });

      const isMock = Boolean(providerResult.isMock);

      return {
        success: true,
        message: isMock ? 'SMS обработано в тестовом режиме (Mock)' : 'SMS успешно отправлено',
        data: {
          id: dbRecord.id,
          clientId,
          clientName,
          phone: normalizedPhone,
          message: cleanedText,
          senderName,
          status: 'sent',
          providerMessageId: providerResult.providerMessageId,
          isMock,
          sentAt: now
        }
      };
    } else {
      await SmsRepository.updateMessageStatus(dbRecord.id, {
        status: 'failed',
        errorCode: providerResult.errorCode,
        errorMessage: providerResult.errorMessage
      });

      return {
        success: false,
        error: {
          code: providerResult.errorCode || 'SMS_SEND_FAILED',
          message: providerResult.errorMessage || 'Не удалось отправить SMS'
        },
        data: {
          id: dbRecord.id,
          phone: normalizedPhone,
          status: 'failed'
        }
      };
    }
  }

  /**
   * Fetch SMS dispatch history.
   */
  async getHistory(filters = {}, user = null) {
    return await SmsRepository.getHistory(filters, user);
  }

  /**
   * Fetch message templates.
   */
  async getTemplates() {
    return await SmsRepository.getTemplates();
  }
}

export const defaultSmsService = new SmsService();
