import { getDB, getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';

function parseOptionalBigInt(val) {
  if (val === undefined || val === null || val === '') return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

export class SmsEventsRepository {
  /**
   * Idempotent event creation using DB ON CONFLICT protection.
   * Returns created or existing event object.
   */
  static async createEvent(eventData) {
    if (!eventData || !eventData.event_type || !eventData.idempotency_key || !eventData.template_code) {
      throw new AppError('Недостаточно данных для создания события SMS Outbox', 400);
    }

    const db = getServiceDB();
    const cleanKey = String(eventData.idempotency_key).trim();

    // 1. Check existing event by idempotency key
    const existing = await this.getByIdempotencyKey(cleanKey);
    if (existing) {
      return { event: existing, created: false };
    }

    const insertPayload = {
      event_type: String(eventData.event_type).toUpperCase(),
      idempotency_key: cleanKey,
      mode: (eventData.mode || 'CONFIRM').toUpperCase(),
      status: (eventData.status || 'AWAITING_CONFIRMATION').toUpperCase(),
      client_id: parseOptionalBigInt(eventData.client_id),
      deal_id: parseOptionalBigInt(eventData.deal_id),
      payment_id: parseOptionalBigInt(eventData.payment_id),
      schedule_id: parseOptionalBigInt(eventData.schedule_id),
      task_id: parseOptionalBigInt(eventData.task_id),
      template_code: String(eventData.template_code).trim(),
      payload_json: eventData.payload_json || {},
      scheduled_at: eventData.scheduled_at || new Date().toISOString(),
      available_at: eventData.available_at || new Date().toISOString()
    };

    const { data, error } = await db
      .from('sms_events')
      .insert([insertPayload])
      .select('*')
      .maybeSingle();

    if (error) {
      // If unique conflict race condition happened, re-fetch existing
      if (error.code === '23505' || error.message?.includes('duplicate key') || error.message?.includes('idempotency_key')) {
        const reFetch = await this.getByIdempotencyKey(cleanKey);
        if (reFetch) return { event: reFetch, created: false };
      }
      console.error('DB error creating sms_event:', error.message);
      throw new AppError(`Ошибка базы данных при создании SMS события: ${error.message}`, 500);
    }

    return { event: data, created: true };
  }

  /**
   * Get single SMS event by ID.
   */
  static async getById(id) {
    const cleanId = parseOptionalBigInt(id);
    if (!cleanId) return null;

    const db = getServiceDB();
    const { data, error } = await db
      .from('sms_events')
      .select('*')
      .eq('id', cleanId)
      .maybeSingle();

    if (error || !data) return null;
    return data;
  }

  /**
   * Get SMS event by idempotency key.
   */
  static async getByIdempotencyKey(key) {
    if (!key) return null;
    const db = getServiceDB();
    const { data, error } = await db
      .from('sms_events')
      .select('*')
      .eq('idempotency_key', String(key).trim())
      .maybeSingle();

    if (error || !data) return null;
    return data;
  }

  /**
   * List SMS events with status/eventType/clientId/dealId filters and pagination.
   */
  static async listEvents(filters = {}) {
    const db = getServiceDB();
    const page = Math.max(1, parseInt(filters.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(filters.limit, 10) || 20));
    const offset = (page - 1) * limit;

    let query = db.from('sms_events').select('*', { count: 'exact' });

    if (filters.status && filters.status !== 'ALL') {
      query = query.eq('status', String(filters.status).toUpperCase());
    }

    if (filters.eventType && filters.eventType !== 'ALL') {
      query = query.eq('event_type', String(filters.eventType).toUpperCase());
    }

    const cleanClientId = parseOptionalBigInt(filters.clientId);
    if (cleanClientId) {
      query = query.eq('client_id', cleanClientId);
    }

    const cleanDealId = parseOptionalBigInt(filters.dealId);
    if (cleanDealId) {
      query = query.eq('deal_id', cleanDealId);
    }

    const cleanScheduleId = parseOptionalBigInt(filters.scheduleId);
    if (cleanScheduleId) {
      query = query.eq('schedule_id', cleanScheduleId);
    }

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, count, error } = await query;

    if (error) {
      console.error('DB error listing sms_events:', error.message);
      return { events: [], total: 0, page, limit, totalPages: 0 };
    }

    const total = count || 0;
    const totalPages = Math.ceil(total / limit);

    return {
      events: data || [],
      total,
      page,
      limit,
      totalPages
    };
  }

  /**
   * Atomic transition from AWAITING_CONFIRMATION to PROCESSING.
   * Returns updated event if successful, or null if event was not in AWAITING_CONFIRMATION status.
   */
  static async atomicStartProcessing(id) {
    const cleanId = parseOptionalBigInt(id);
    if (!cleanId) return null;

    const db = getServiceDB();
    const { data, error } = await db
      .from('sms_events')
      .update({
        status: 'PROCESSING',
        updated_at: new Date().toISOString()
      })
      .eq('id', cleanId)
      .eq('status', 'AWAITING_CONFIRMATION')
      .select('*')
      .maybeSingle();

    if (error || !data) {
      return null;
    }

    return data;
  }

  /**
   * Revert PROCESSING event back to AWAITING_CONFIRMATION (e.g. when preview text changed before dispatch).
   */
  static async revertToAwaitingConfirmation(id) {
    const cleanId = parseOptionalBigInt(id);
    if (!cleanId) return null;

    const db = getServiceDB();
    const { data, error } = await db
      .from('sms_events')
      .update({
        status: 'AWAITING_CONFIRMATION',
        updated_at: new Date().toISOString()
      })
      .eq('id', cleanId)
      .select('*')
      .maybeSingle();

    if (error || !data) return null;
    return data;
  }

  /**
   * Mark event as SENT and link confirmed_by, confirmed_at, and sms_message_id.
   */
  static async markSent({ id, smsMessageId = null, userId = null }) {
    const cleanId = parseOptionalBigInt(id);
    if (!cleanId) return null;

    const db = getServiceDB();
    const updateData = {
      status: 'SENT',
      updated_at: new Date().toISOString()
    };

    const cleanMsgId = parseOptionalBigInt(smsMessageId);
    if (cleanMsgId) updateData.sms_message_id = cleanMsgId;

    const cleanUserId = parseOptionalBigInt(userId);
    if (cleanUserId) {
      updateData.confirmed_by = cleanUserId;
      updateData.confirmed_at = new Date().toISOString();
    }

    const { data, error } = await db
      .from('sms_events')
      .update(updateData)
      .eq('id', cleanId)
      .select('*')
      .maybeSingle();

    if (error) return null;
    return data;
  }

  /**
   * Mark event as FAILED with error code and message.
   */
  static async markFailed({ id, failureCode = null, failureMessage = null }) {
    const cleanId = parseOptionalBigInt(id);
    if (!cleanId) return null;

    const db = getServiceDB();
    const { data, error } = await db
      .from('sms_events')
      .update({
        status: 'FAILED',
        failure_code: failureCode ? String(failureCode).substring(0, 50) : 'FAILED',
        failure_message: failureMessage ? String(failureMessage).substring(0, 500) : null,
        updated_at: new Date().toISOString()
      })
      .eq('id', cleanId)
      .select('*')
      .maybeSingle();

    if (error) return null;
    return data;
  }

  /**
   * Mark event as DELIVERY_UNKNOWN (e.g. gateway request timed out / uncertain outcome).
   */
  static async markDeliveryUnknown({ id, failureCode = null, failureMessage = null }) {
    const cleanId = parseOptionalBigInt(id);
    if (!cleanId) return null;

    const db = getServiceDB();
    const { data, error } = await db
      .from('sms_events')
      .update({
        status: 'DELIVERY_UNKNOWN',
        failure_code: failureCode ? String(failureCode).substring(0, 50) : 'PAYOM_TIMEOUT',
        failure_message: failureMessage ? String(failureMessage).substring(0, 500) : null,
        updated_at: new Date().toISOString()
      })
      .eq('id', cleanId)
      .select('*')
      .maybeSingle();

    if (error) return null;
    return data;
  }

  /**
   * Cancel event from AWAITING_CONFIRMATION status.
   */
  static async cancelEvent({ id, userId = null, reason = null }) {
    const cleanId = parseOptionalBigInt(id);
    if (!cleanId) return null;

    const db = getServiceDB();
    const updateData = {
      status: 'CANCELLED',
      cancel_reason: reason ? String(reason).substring(0, 500) : 'Отменено пользователем',
      updated_at: new Date().toISOString()
    };

    const cleanUserId = parseOptionalBigInt(userId);
    if (cleanUserId) {
      updateData.cancelled_by = cleanUserId;
      updateData.cancelled_at = new Date().toISOString();
    }

    const { data, error } = await db
      .from('sms_events')
      .update(updateData)
      .eq('id', cleanId)
      .eq('status', 'AWAITING_CONFIRMATION')
      .select('*')
      .maybeSingle();

    if (error || !data) return null;
    return data;
  }
}
