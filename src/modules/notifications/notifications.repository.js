import { getDB } from '../../db/connection.js';

export class NotificationsRepository {
  static async getAdminUserIds() {
    const db = getDB();
    const { data, error } = await db
      .from('users')
      .select('id')
      .eq('role', 'ADMIN')
      .eq('is_active', true);

    if (error || !data) return [1]; // fallback to admin user ID 1
    return data.map(u => u.id);
  }

  static async createNotification(data) {
    const db = getDB();
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

  static async getUserNotifications(userId, filters = {}) {
    const db = getDB();
    let query = db
      .from('user_notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (filters.is_read !== undefined && filters.is_read !== null) {
      query = query.eq('is_read', Boolean(filters.is_read));
    }

    const limit = filters.limit ? Number(filters.limit) : 50;
    const offset = filters.offset ? Number(filters.offset) : 0;

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
    const db = getDB();
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
    const db = getDB();
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
    const db = getDB();
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
