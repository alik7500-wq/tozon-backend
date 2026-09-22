import { getServiceDB } from '../../db/connection.js';
import { parseOptionalBigInt, parseRequiredBigInt } from '../../utils/idNormalizer.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export class SmsRepository {
  /**
   * Create an initial record in sms_messages table using server-only service_role connection.
   */
  static async createMessage({
    clientId = null,
    dealId = null,
    contractId = null,
    phone,
    message,
    provider = 'PAYOM',
    senderName = 'TOZON-PLAZA',
    status = 'queued',
    createdBy = null
  }) {
    const db = getServiceDB();
    const now = new Date().toISOString();

    const payload = {
      client_id: parseOptionalBigInt(clientId),
      deal_id: parseOptionalBigInt(dealId),
      contract_id: parseOptionalBigInt(contractId),
      phone,
      message,
      provider,
      sender_name: senderName,
      status,
      created_by: parseOptionalBigInt(createdBy),
      created_at: now,
      updated_at: now
    };

    const { data, error } = await db
      .from('sms_messages')
      .insert([payload])
      .select()
      .single();

    if (error) {
      console.error('DB error inserting sms_messages:', error.message);

      // Fallback allowed ONLY in unit tests if explicitly enabled
      if (process.env.NODE_ENV === 'test' && process.env.ALLOW_SMS_REPOSITORY_MOCK_FALLBACK === 'true') {
        return {
          id: Date.now(),
          ...payload
        };
      }

      throw new AppError(`Не удалось сохранить запись SMS в базу данных: ${error.message}`, 500, 'SMS_DB_PERSISTENCE_FAILED');
    }

    return data;
  }

  /**
   * Update message delivery status, provider message ID, or error details.
   */
  static async updateMessageStatus(id, {
    status,
    providerMessageId = null,
    errorCode = null,
    errorMessage = null,
    sentAt = null,
    deliveredAt = null
  }) {
    const db = getServiceDB();
    const cleanId = parseOptionalBigInt(id);
    if (!cleanId) return null;

    const now = new Date().toISOString();
    const updates = {
      status,
      updated_at: now
    };

    if (providerMessageId !== null) updates.provider_message_id = providerMessageId;
    if (errorCode !== null) updates.error_code = errorCode;
    if (errorMessage !== null) updates.error_message = errorMessage;
    if (sentAt !== null) updates.sent_at = sentAt;
    if (deliveredAt !== null) updates.delivered_at = deliveredAt;

    const { data, error } = await db
      .from('sms_messages')
      .update(updates)
      .eq('id', cleanId)
      .select()
      .single();

    if (error) {
      console.error('DB error updating sms_messages status:', error.message);
      if (process.env.NODE_ENV === 'production') {
        throw new AppError(`Не удалось обновить статус SMS в базе данных: ${error.message}`, 500, 'SMS_DB_UPDATE_FAILED');
      }
      return null;
    }

    return data;
  }

  /**
   * Find SMS message by providerMessageId.
   */
  static async findByProviderMessageId(providerMessageId) {
    if (!providerMessageId) return null;
    const db = getServiceDB();

    const { data, error } = await db
      .from('sms_messages')
      .select('*')
      .eq('provider_message_id', String(providerMessageId))
      .maybeSingle();

    if (error) return null;
    return data;
  }

  /**
   * Get SMS history with optional client, status, or date filtering.
   */
  static async getHistory(filters = {}) {
    const db = getServiceDB();
    let query = db
      .from('sms_messages')
      .select(`
        *,
        leads!client_id(full_name, phone),
        users!created_by(name)
      `)
      .order('created_at', { ascending: false });

    const cleanClientId = parseOptionalBigInt(filters.clientId);
    if (cleanClientId) query = query.eq('client_id', cleanClientId);

    if (filters.status && filters.status !== 'ALL') {
      query = query.eq('status', filters.status);
    }

    const { data, error } = await query;

    if (error) {
      console.error('DB error reading sms_messages history:', error.message);
      return [];
    }

    return (data || []).map(row => ({
      ...row,
      client_name: row.leads?.full_name || null,
      client_phone: row.leads?.phone || null,
      created_by_name: row.users?.name || 'Система',
      leads: undefined,
      users: undefined
    }));
  }

  /**
   * Get active SMS templates.
   */
  static async getTemplates() {
    const db = getServiceDB();
    const { data, error } = await db
      .from('sms_templates')
      .select('*')
      .eq('is_active', true)
      .order('id', { ascending: true });

    if (error) {
      console.error('DB error reading sms_templates:', error.message);
      return [
        { id: 1, code: 'CLIENT_WELCOME', name: 'Приветствие клиента', text: 'Уважаемый(ая) {{client_name}}, спасибо за обращение в отдел продаж ЖК TOZON-PLAZA!' },
        { id: 2, code: 'MEETING_REMINDER', name: 'Напоминание о встрече', text: 'Здравствуйте, {{client_name}}! Напоминаем о встрече в офисе TOZON-PLAZA.' },
        { id: 3, code: 'CUSTOM_MESSAGE', name: 'Произвольное сообщение', text: '{{text}}' }
      ];
    }

    return data || [];
  }
}
