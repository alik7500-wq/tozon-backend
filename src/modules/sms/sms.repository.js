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
    eventId = null,
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
      event_id: parseOptionalBigInt(eventId),
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
   * Get single message by ID.
   */
  static async getById(id) {
    const cleanId = parseOptionalBigInt(id);
    if (!cleanId) return null;
    const db = getServiceDB();
    const { data, error } = await db
      .from('sms_messages')
      .select('*')
      .eq('id', cleanId)
      .maybeSingle();

    if (error) {
      if (process.env.NODE_ENV === 'test' && process.env.ALLOW_SMS_REPOSITORY_MOCK_FALLBACK === 'true') {
        return { id: cleanId, status: 'queued' };
      }
      return null;
    }
    return data;
  }

  /**
   * Get all messages linked to an event_id (with context fallback for legacy historical rows).
   */
  static async getMessagesByEventId(eventId) {
    const cleanId = parseOptionalBigInt(eventId);
    if (!cleanId) return [];
    const db = getServiceDB();
    const { data, error } = await db
      .from('sms_messages')
      .select('*')
      .eq('event_id', cleanId)
      .order('id', { ascending: true });

    if (!error && data && data.length > 0) {
      return data;
    }

    // Context fallback for legacy historical rows created before event_id back-population
    const { data: ev } = await db.from('sms_events').select('*').eq('id', cleanId).maybeSingle();
    if (!ev) return [];

    let fallbackQuery = db.from('sms_messages').select('*').order('id', { ascending: true });
    if (ev.client_id) fallbackQuery = fallbackQuery.eq('client_id', ev.client_id);
    if (ev.deal_id) fallbackQuery = fallbackQuery.eq('deal_id', ev.deal_id);
    if (ev.created_at) fallbackQuery = fallbackQuery.gte('created_at', ev.created_at);

    const { data: fallbackMsgs } = await fallbackQuery;
    return fallbackMsgs || [];
  }

  /**
   * Update message delivery status, phone, message, provider message ID, or error details.
   */
  static async updateMessageStatus(id, {
    status,
    phone = null,
    message = null,
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

    if (phone !== null) updates.phone = phone;
    if (message !== null) updates.message = message;
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
    const {data,error}=await getServiceDB().from('sms_templates').select('id, code, name, text, is_active, customized_at').eq('is_active',true).order('id',{ascending:true});
    if(error || !data) throw new AppError('Не удалось прочитать шаблоны SMS',503);
    return data.filter(t=>t.code!=='CUSTOM_MESSAGE');
  }
}



