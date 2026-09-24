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
    paymentId = null,
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
      payment_id: parseOptionalBigInt(paymentId),
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

      if (error.code === '23505') {
        throw new AppError('Подтверждение оплаты для данного платежа уже было отправлено', 400, 'SMS_DUPLICATE_PAYMENT_RECEIVED');
      }

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
   * Get SMS history with optional client, status, or user filtering.
   */
  static async getHistory(filters = {}, user = null) {
    const db = getServiceDB();
    let query = db
      .from('sms_messages')
      .select(`
        *,
        leads!client_id(full_name, phone),
        users!created_by(name)
      `);

    const cleanClientId = parseOptionalBigInt(filters.clientId);
    if (cleanClientId) {
      query = query.eq('client_id', cleanClientId);
    } else if (user) {
      const isGlobalAdminOrDirector =
        user.role === 'ADMIN' ||
        user.role === 'DIRECTOR' ||
        (Array.isArray(user.permissions) && (user.permissions.includes('*') || user.permissions.includes('sms.history.all')));

      if (!isGlobalAdminOrDirector && user.id) {
        const cleanUserId = parseOptionalBigInt(user.id);
        if (cleanUserId) {
          query = query.eq('created_by', cleanUserId);
        }
      }
    }

    if (filters.status && filters.status !== 'ALL') {
      query = query.eq('status', filters.status);
    }

    query = query.order('created_at', { ascending: false });

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
   * Get active SMS templates directly from DB (Single Source of Truth).
   */
  static async getTemplates() {
    const defaultTemplates = [
      { id: 1, code: 'CLIENT_WELCOME', name: 'Приветствие клиента', text: 'Здравствуйте, {{client_name}}! Спасибо за обращение в отдел продаж ЖК TOZON-PLAZA.', is_active: true },
      { id: 2, code: 'MEETING_REMINDER', name: 'Напоминание о встрече', text: 'Здравствуйте, {{client_name}}! Напоминаем о запланированной встрече {{meeting_date}} в {{meeting_time}}. TOZON-PLAZA.', is_active: true },
      { id: 3, code: 'DEAL_INFO', name: 'Сообщение по договору', text: '{{client_name}}: дог. №{{contract_number}}, кв. №{{apartment}} ({{apartment_area}} м²). Стоимость {{contract_total}} {{currency}}, оплачено {{total_paid}} {{currency}}, остаток {{remaining_balance}} {{currency}}. {{project_name}}', is_active: true },
      { id: 4, code: 'PAYMENT_REMINDER', name: 'Напоминание об оплате', text: 'Здравствуйте, {{client_name}}! Напоминаем об очередной оплате по договору №{{contract_number}} в размере {{payment_amount}} {{currency}} до {{payment_date}}. TOZON-PLAZA.', is_active: true },
      { id: 5, code: 'DEBTOR_REMINDER', name: 'Напоминание о задолженности', text: 'Уважаемый(ая) {{client_name}}! Просим внести просроченную оплату {{overdue_amount}} {{currency}} по договору №{{contract_number}}. TOZON-PLAZA.', is_active: true },
      { id: 6, code: 'PAYMENT_RECEIVED', name: 'Подтверждение оплаты', text: 'Уважаемый(ая) {{client_name}}! Оплата по договору №{{contract_number}} на сумму {{payment_amount}} {{payment_currency}} принята. Всего оплачено {{total_paid}} {{contract_currency}}. Остаток по договору: {{remaining_balance}} {{contract_currency}}. Спасибо! TOZON-PLAZA.', is_active: true }
    ];

    try {
      const db = getServiceDB();
      const { data, error } = await db
        .from('sms_templates')
        .select('id, code, name, text, is_active')
        .eq('is_active', true)
        .order('id', { ascending: true });

      if (error || !data || data.length === 0) {
        return defaultTemplates;
      }

      return data.filter((t) => t.code !== 'CUSTOM_MESSAGE');
    } catch (err) {
      return defaultTemplates;
    }
  }
}



