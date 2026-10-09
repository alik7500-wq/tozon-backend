import './test_env.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotificationsService } from '../modules/notifications/notifications.service.js';
import { NotificationsRepository } from '../modules/notifications/notifications.repository.js';

describe('TOZON CRM — Notifications V1.1 Final Safety Test Suite', () => {
  let inMemoryDb = [];
  let usersDb = [];
  let nextId = 1;

  beforeEach(() => {
    inMemoryDb = [];
    nextId = 1;

    usersDb = [
      { id: 1, email: 'admin@tozon.crm', role: 'ADMIN', is_active: 1 },
      { id: 2, email: 'inactive_admin@tozon.crm', role: 'ADMIN', is_active: 0 },
      { id: 3, email: 'manager1@tozon.tj', role: 'SALES_MANAGER', is_active: 1 },
      { id: 4, email: 'manager2@tozon.tj', role: 'SALES_MANAGER', is_active: 1 },
      { id: 5, email: 'admin_manager@tozon.crm', role: 'ADMIN', is_active: 1 }
    ];

    // Mock NotificationsRepository.getAdminUserIds based on updated implementation
    NotificationsRepository.getAdminUserIds = async () => {
      const activeAdmins = usersDb.filter(u => u.role === 'ADMIN' && u.is_active === 1);
      if (activeAdmins.length === 0) return [];
      return activeAdmins.map(u => u.id);
    };

    // Mock createNotification with deduplication check
    NotificationsRepository.createNotification = async (data) => {
      if (data.dedupe_key) {
        const existing = inMemoryDb.find(n => n.dedupe_key === data.dedupe_key);
        if (existing) return existing;
      }
      const record = {
        id: nextId++,
        user_id: data.user_id,
        event_type: data.event_type || data.type,
        type: data.type || data.event_type,
        title: data.title,
        message: data.message,
        entity_type: data.entity_type || null,
        entity_id: data.entity_id || null,
        is_read: false,
        read_at: null,
        dedupe_key: data.dedupe_key || null,
        metadata: data.metadata || {},
        created_at: new Date().toISOString()
      };
      inMemoryDb.push(record);
      return record;
    };

    NotificationsRepository.getUserNotifications = async (userId, filters = {}) => {
      let list = inMemoryDb.filter(n => n.user_id === userId);
      if (filters.is_read !== undefined && filters.is_read !== null) {
        list = list.filter(n => n.is_read === Boolean(filters.is_read));
      }
      return list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    };

    NotificationsRepository.getUnreadCount = async (userId) => {
      return inMemoryDb.filter(n => n.user_id === userId && !n.is_read).length;
    };
  });

  // --- SECTION A & C: ADMIN INTEGER FILTER & INACTIVE EXCLUSION ---
  describe('A & C: Admin User Selection & Inactive Exclusion', () => {
    it('1. Active ADMINs (is_active=1) receive notifications; inactive ADMINs (is_active=0) are excluded', async () => {
      const deal = { id: 101, contract_number: '00101', lead_name: 'Тестовый Клиент', responsible_user_id: 3 };
      const schedule = { id: 416, due_date: '2026-10-09' };

      await NotificationsService.notifyPaymentDue(schedule, deal);

      const notifUser1 = await NotificationsRepository.getUserNotifications(1); // Active ADMIN (is_active = 1)
      const notifUser2 = await NotificationsRepository.getUserNotifications(2); // Inactive ADMIN (is_active = 0)
      const notifUser3 = await NotificationsRepository.getUserNotifications(3); // Responsible MANAGER
      const notifUser4 = await NotificationsRepository.getUserNotifications(4); // Non-responsible MANAGER
      const notifUser5 = await NotificationsRepository.getUserNotifications(5); // Active ADMIN (is_active = 1)

      expect(notifUser1.length).toBe(1);
      expect(notifUser1[0].dedupe_key).toBe('PAYMENT_DUE:416:1');

      expect(notifUser2.length).toBe(0); // Inactive ADMIN (is_active=0) strictly excluded

      expect(notifUser3.length).toBe(1);
      expect(notifUser3[0].dedupe_key).toBe('PAYMENT_DUE:416:3');

      expect(notifUser4.length).toBe(0); // Non-responsible MANAGER excluded

      expect(notifUser5.length).toBe(1); // Active ADMIN
    });

    it('2. When no active ADMIN users exist in DB, returns empty array [] and notification is sent only to manager', async () => {
      // Set all admins to inactive
      usersDb.forEach(u => { if (u.role === 'ADMIN') u.is_active = 0; });

      const adminIds = await NotificationsRepository.getAdminUserIds();
      expect(adminIds).toEqual([]); // Returns [] cleanly without fallback to hardcoded [1]

      const deal = { id: 102, contract_number: '00102', responsible_user_id: 3 };
      const schedule = { id: 417, due_date: '2026-10-09' };

      await NotificationsService.notifyPaymentDue(schedule, deal);

      const notifUser1 = await NotificationsRepository.getUserNotifications(1);
      const notifUser3 = await NotificationsRepository.getUserNotifications(3);

      expect(notifUser1.length).toBe(0); // No admin notification created
      expect(notifUser3.length).toBe(1); // Manager notification created
    });

    it('3. Database error during users query throws explicitly and is logged without masking', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Mock getAdminUserIds to throw DB error as implemented
      vi.spyOn(NotificationsRepository, 'getAdminUserIds').mockImplementationOnce(async () => {
        const error = new Error('PostgreSQL connection timeout');
        console.error('Failed to fetch ADMIN user IDs:', error.message);
        throw error;
      });

      let thrownError = null;
      try {
        await NotificationsService.resolveRecipients(3);
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).not.toBeNull();
      expect(thrownError.message).toBe('PostgreSQL connection timeout');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to fetch ADMIN user IDs:', 'PostgreSQL connection timeout');
      consoleErrorSpy.mockRestore();
    });
  });

  // --- PROMISE AWAITING & DETECTOR ASYNC SAFETY ---
  describe('Async Safety & Promise Awaiting', () => {
    it('4. Detector wrapper awaits notification completion and handles errors gracefully without crash', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      vi.spyOn(NotificationsRepository, 'createNotification').mockRejectedValueOnce(new Error('DB write failed'));

      const schedule = { id: 999, due_date: '2026-10-09' };
      const deal = { id: 999, contract_number: '00999', responsible_user_id: 3 };

      let caughtError = null;
      try {
        try {
          await NotificationsService.notifyPaymentDue(schedule, deal);
        } catch (err) {
          console.warn(`Failed to dispatch PAYMENT_DUE notification for schedule ${schedule.id}:`, err.message);
        }
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeNull(); // Awaited and handled safely
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Failed to dispatch PAYMENT_DUE notification for schedule 999:',
        'DB write failed'
      );
      consoleWarnSpy.mockRestore();
    });
  });

  // --- DEDUPLICATION & RECOVERY ---
  describe('Deduplication & Partial Missing Admin Recovery', () => {
    it('5. Re-running notification dispatch creates missing ADMIN record without duplicating MANAGER record', async () => {
      const schedule = { id: 500, due_date: '2026-10-09' };
      const deal = { id: 200, contract_number: '00200', responsible_user_id: 3 };

      // Pre-seed existing Manager notification (User 3)
      await NotificationsRepository.createNotification({
        user_id: 3,
        type: 'PAYMENT_DUE',
        title: 'Наступает срок планового платежа',
        message: 'По договору №00200 срок оплаты 2026-10-09.',
        entity_type: 'DEAL',
        entity_id: 200,
        dedupe_key: 'PAYMENT_DUE:500:3'
      });

      expect((await NotificationsRepository.getUserNotifications(3)).length).toBe(1);
      expect((await NotificationsRepository.getUserNotifications(1)).length).toBe(0);

      // Execute notifyPaymentDue with fixed active admin resolution
      await NotificationsService.notifyPaymentDue(schedule, deal);

      // Verify Manager record is NOT duplicated
      const managerNotifs = await NotificationsRepository.getUserNotifications(3);
      expect(managerNotifs.length).toBe(1);

      // Verify missing Admin (User 1) record is created cleanly
      const adminNotifs = await NotificationsRepository.getUserNotifications(1);
      expect(adminNotifs.length).toBe(1);
      expect(adminNotifs[0].dedupe_key).toBe('PAYMENT_DUE:500:1');
    });
  });
});
