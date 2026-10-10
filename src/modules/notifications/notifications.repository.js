import { getServiceDB } from '../../db/connection.js';

export class NotificationsRepository {
  static async getAdminUserIds() {
    const db = getServiceDB();
    const { data, error } = await db
      .from('users')
      .select('id')
      .eq('role', 'ADMIN')
      .eq('is_active', 1);

    if (error) {
      console.error('Failed to fetch ADMIN user IDs:', error.message);
      throw error;
    }

    if (!data || data.length === 0) return [];
    return data.map(u => u.id);
  }

  static async createNotification(data) {
    const db = getServiceDB();
    const payload = {
      user_id: data.user_id,
      event_type: data.event_type || data.type,
      type: data.type || data.event_type,
      title: data.title,
      message: data.message,
      entity_type: data.entity_type || null,
      entity_id: data.entity_id ? Number(data.entity_id) : null,
      action_url: data.action_url || null,
      dedupe_key: data.dedupe_key || null,
      metadata: data.metadata || {},
      created_at: new Date().toISOString()
    };

    if (payload.dedupe_key) {
      // Check existing to enforce deduplication cleanly across all environments
      const { data: existing } = await db
        .from('user_notifications')
        .select('id')
        .eq('dedupe_key', payload.dedupe_key)
        .maybeSingle();

      if (existing) return existing;
    }

    const { data: inserted, error } = await db
      .from('user_notifications')
      .insert([payload])
      .select()
      .maybeSingle();

    if (error && (error.code === '23505' || error.message?.includes('duplicate key') || error.message?.includes('dedupe_key'))) {
      const { data: existing } = await db
        .from('user_notifications')
        .select('id')
        .eq('dedupe_key', payload.dedupe_key)
        .maybeSingle();
      return existing;
    }

    return inserted;
  }

  static async getNotificationStats(userId) {
    const db = getServiceDB();
    const { data, error } = await db
      .from('user_notifications')
      .select('event_type, type, is_read')
      .eq('user_id', userId);

    if (error) {
      if (error.code === '42P01' || error.message?.includes('does not exist')) {
        return { total: 0, unread: 0, payments: 0, leads_and_reservations: 0, sms_failed: 0 };
      }
      throw error;
    }

    const list = data || [];
    return {
      total: list.length,
      unread: list.filter(n => !n.is_read).length,
      payments: list.filter(n => {
        const type = n.event_type || n.type;
        return type === 'PAYMENT_DUE' || type === 'PAYMENT_OVERDUE';
      }).length,
      leads_and_reservations: list.filter(n => {
        const type = n.event_type || n.type;
        return type === 'LEAD_CREATED' || type === 'RESERVATION_CREATED';
      }).length,
      sms_failed: list.filter(n => (n.event_type || n.type) === 'SMS_FAILED').length
    };
  }

  static async getUserNotifications(userId, filters = {}) {
    const db = getServiceDB();
    let query = db
      .from('user_notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (filters.is_read !== undefined && filters.is_read !== null && filters.is_read !== '') {
      query = query.eq('is_read', String(filters.is_read) === 'true');
    }

    if (filters.category) {
      if (filters.category === 'unread') {
        query = query.eq('is_read', false);
      } else if (filters.category === 'payments') {
        query = query.in('event_type', ['PAYMENT_DUE', 'PAYMENT_OVERDUE']);
      } else if (filters.category === 'leads') {
        query = query.in('event_type', ['LEAD_CREATED', 'RESERVATION_CREATED']);
      } else if (filters.category === 'sms') {
        query = query.eq('event_type', 'SMS_FAILED');
      }
    }

    const page = filters.page ? Math.max(1, Number(filters.page)) : null;
    const limit = filters.limit ? Math.min(1000, Number(filters.limit)) : 200;
    const offset = page ? (page - 1) * limit : (filters.offset ? Number(filters.offset) : 0);

    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;
    if (error) {
      // Graceful fallback if table does not yet exist before migration
      if (error.code === '42P01' || error.message?.includes('does not exist')) {
        return [];
      }
      throw error;
    }
    return data || [];
  }

  static async getUnreadCount(userId) {
    const db = getServiceDB();
    const { count, error } = await db
      .from('user_notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_read', false);

    if (error) {
      if (error.code === '42P01' || error.message?.includes('does not exist')) {
        return 0;
      }
      throw error;
    }
    return count || 0;
  }

  static async markAsRead(notificationId, userId) {
    const db = getServiceDB();
    const now = new Date().toISOString();

    const { data, error } = await db
      .from('user_notifications')
      .update({ is_read: true, read_at: now })
      .eq('id', notificationId)
      .eq('user_id', userId)
      .select()
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  static async markAllAsRead(userId) {
    const db = getServiceDB();
    const now = new Date().toISOString();

    const { data, error } = await db
      .from('user_notifications')
      .update({ is_read: true, read_at: now })
      .eq('user_id', userId)
      .eq('is_read', false)
      .select();

    if (error) throw error;
    return data || [];
  }
}
