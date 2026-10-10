import './test_env.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotificationsService } from '../modules/notifications/notifications.service.js';
import { NotificationsRepository } from '../modules/notifications/notifications.repository.js';

describe('TOZON CRM — Notifications V1.3 Final Safety Gate Test Suite', () => {
  let dbStore = [];
  let nextId = 1;

  beforeEach(() => {
    dbStore = [];
    nextId = 1;

    // Mock NotificationsRepository methods
    NotificationsRepository.getNotificationStats = async (userId) => {
      const userList = dbStore.filter(n => n.user_id === userId);
      return {
        total: userList.length,
        unread: userList.filter(n => !n.is_read).length,
        payments: userList.filter(n => {
          const type = n.event_type || n.type;
          return type === 'PAYMENT_DUE' || type === 'PAYMENT_OVERDUE';
        }).length,
        leads_and_reservations: userList.filter(n => {
          const type = n.event_type || n.type;
          return type === 'LEAD_CREATED' || type === 'RESERVATION_CREATED';
        }).length,
        sms_failed: userList.filter(n => (n.event_type || n.type) === 'SMS_FAILED').length
      };
    };

    NotificationsRepository.getUserNotifications = async (userId, filters = {}) => {
      let list = dbStore.filter(n => n.user_id === userId);

      if (filters.is_read !== undefined && filters.is_read !== null && filters.is_read !== '') {
        list = list.filter(n => n.is_read === (String(filters.is_read) === 'true'));
      }

      if (filters.category) {
        if (filters.category === 'unread') {
          list = list.filter(n => !n.is_read);
        } else if (filters.category === 'payments') {
          list = list.filter(n => {
            const t = n.event_type || n.type;
            return t === 'PAYMENT_DUE' || t === 'PAYMENT_OVERDUE';
          });
        } else if (filters.category === 'leads') {
          list = list.filter(n => {
            const t = n.event_type || n.type;
            return t === 'LEAD_CREATED' || t === 'RESERVATION_CREATED';
          });
        } else if (filters.category === 'sms') {
          list = list.filter(n => (n.event_type || n.type) === 'SMS_FAILED');
        }
      }

      list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      const page = filters.page ? Math.max(1, Number(filters.page)) : null;
      const limit = filters.limit ? Math.min(1000, Number(filters.limit)) : 200;
      const offset = page ? (page - 1) * limit : (filters.offset ? Number(filters.offset) : 0);

      return list.slice(offset, offset + limit);
    };

    NotificationsRepository.markAsRead = async (notificationId, userId) => {
      const target = dbStore.find(n => n.id === notificationId && n.user_id === userId);
      if (target) {
        target.is_read = true;
        target.read_at = new Date().toISOString();
      }
      return target || null;
    };

    NotificationsRepository.markAllAsRead = async (userId) => {
      const updated = [];
      for (const n of dbStore) {
        if (n.user_id === userId && !n.is_read) {
          n.is_read = true;
          n.read_at = new Date().toISOString();
          updated.push(n);
        }
      }
      return updated;
    };
  });

  // --- SECTION A: SERVER-SIDE STATS & LARGE DATASET HANDLING (200, 201, 500) ---
  describe('Server-Side Stats & Large Datasets (0, 1, 200, 201, 500 items)', () => {
    it('1. Handles 0 notifications dataset gracefully', async () => {
      const stats = await NotificationsService.getNotificationStats(1);
      const list = await NotificationsService.getUserNotifications(1);

      expect(stats).toEqual({
        total: 0,
        unread: 0,
        payments: 0,
        leads_and_reservations: 0,
        sms_failed: 0
      });
      expect(list.length).toBe(0);
    });

    it('2. Handles 1 notification dataset accurately', async () => {
      dbStore.push({
        id: nextId++,
        user_id: 1,
        event_type: 'PAYMENT_DUE',
        type: 'PAYMENT_DUE',
        title: 'Срок платежа',
        message: 'По договору №100',
        is_read: false,
        created_at: new Date().toISOString()
      });

      const stats = await NotificationsService.getNotificationStats(1);
      expect(stats.total).toBe(1);
      expect(stats.unread).toBe(1);
      expect(stats.payments).toBe(1);
    });

    it('3. Handles 201 and 500 notifications dataset with accurate server-side stats & pagination', async () => {
      // Seed 500 notifications for User ID 1 (250 payments, 150 leads, 100 sms_failed; 200 unread)
      for (let i = 1; i <= 500; i++) {
        let type = 'PAYMENT_DUE';
        if (i > 250 && i <= 400) type = 'LEAD_CREATED';
        if (i > 400) type = 'SMS_FAILED';

        dbStore.push({
          id: nextId++,
          user_id: 1,
          event_type: type,
          type: type,
          title: `Notification ${i}`,
          message: `Message ${i}`,
          is_read: i > 200, // First 200 are unread, remaining 300 are read
          created_at: new Date(Date.now() - i * 1000).toISOString()
        });
      }

      // Check server stats
      const stats = await NotificationsService.getNotificationStats(1);
      expect(stats.total).toBe(500);
      expect(stats.unread).toBe(200);
      expect(stats.payments).toBe(250);
      expect(stats.leads_and_reservations).toBe(150);
      expect(stats.sms_failed).toBe(100);

      // Check paginated queries
      const page1 = await NotificationsService.getUserNotifications(1, { page: 1, limit: 100 });
      const page2 = await NotificationsService.getUserNotifications(1, { page: 2, limit: 100 });
      const page3 = await NotificationsService.getUserNotifications(1, { page: 3, limit: 100 });

      expect(page1.length).toBe(100);
      expect(page2.length).toBe(100);
      expect(page3.length).toBe(100);

      // Category specific query: payments category
      const paymentsCategory = await NotificationsService.getUserNotifications(1, { category: 'payments', limit: 300 });
      expect(paymentsCategory.length).toBe(250); // Exactly 250 payment notifications returned

      // Unread category query
      const unreadCategory = await NotificationsService.getUserNotifications(1, { category: 'unread', limit: 300 });
      expect(unreadCategory.length).toBe(200); // Exactly 200 unread notifications returned
    });
  });

  // --- SECTION B & C: READ ERROR HANDLING & RBAC SCOPING ---
  describe('Read Error Handling & User Isolation (RBAC)', () => {
    it('4. User ID isolation: User 1 cannot see User 3 notifications', async () => {
      dbStore.push({ id: nextId++, user_id: 1, type: 'PAYMENT_DUE', is_read: false, created_at: new Date().toISOString() });
      dbStore.push({ id: nextId++, user_id: 3, type: 'PAYMENT_DUE', is_read: false, created_at: new Date().toISOString() });

      const statsUser1 = await NotificationsService.getNotificationStats(1);
      const statsUser3 = await NotificationsService.getNotificationStats(3);

      expect(statsUser1.total).toBe(1);
      expect(statsUser3.total).toBe(1);

      const listUser1 = await NotificationsService.getUserNotifications(1);
      expect(listUser1[0].user_id).toBe(1);
    });

    it('5. Read single and read all update status cleanly', async () => {
      dbStore.push({ id: 10, user_id: 1, type: 'PAYMENT_DUE', is_read: false, created_at: new Date().toISOString() });
      dbStore.push({ id: 11, user_id: 1, type: 'PAYMENT_DUE', is_read: false, created_at: new Date().toISOString() });

      await NotificationsService.markAsRead(10, 1);
      let stats = await NotificationsService.getNotificationStats(1);
      expect(stats.unread).toBe(1);

      await NotificationsService.markAllAsRead(1);
      stats = await NotificationsService.getNotificationStats(1);
      expect(stats.unread).toBe(0);
    });
  });
});
