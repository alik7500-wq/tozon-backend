import './test_env.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotificationsService } from '../modules/notifications/notifications.service.js';
import { NotificationsRepository } from '../modules/notifications/notifications.repository.js';
import { getServiceDB } from '../db/connection.js';

vi.mock('../db/connection.js', () => ({
  getServiceDB: vi.fn(),
  getDB: vi.fn(),
  assertSafeTestDatabase: vi.fn(() => true)
}));

describe('TOZON CRM — Sales Automation V1.1 Digest Recipient Hotfix Test Suite', () => {
  let inMemoryDb = [];
  let nextId = 1;

  beforeEach(() => {
    vi.clearAllMocks();
    inMemoryDb = [];
    nextId = 1;
  });

  // =========================================================================
  // SUITE 1: NotificationsRepository.getManagementUserIds() role and is_active filtering
  // =========================================================================
  describe('1. NotificationsRepository.getManagementUserIds()', () => {
    it('correctly includes active ADMIN and DIRECTOR users, and strictly excludes SALES_MANAGER and FINANCE_MANAGER', async () => {
      const mockUsers = [
        { id: 1, name: 'Admin One', role: 'ADMIN', is_active: 1 },
        { id: 2, name: 'Director One', role: 'DIRECTOR', is_active: 1 },
        { id: 3, name: 'Sales Manager One', role: 'SALES_MANAGER', is_active: 1 },
        { id: 4, name: 'Sales Manager Two', role: 'SALES_MANAGER', is_active: 1 },
        { id: 5, name: 'Admin Two', role: 'ADMIN', is_active: 1 },
        { id: 6, name: 'Finance Manager One', role: 'FINANCE_MANAGER', is_active: 1 }
      ];

      const mockDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        in: vi.fn((col, vals) => {
          return {
            data: mockUsers.filter(u => vals.includes(u.role)),
            error: null
          };
        })
      };
      getServiceDB.mockReturnValue(mockDb);

      const recipientIds = await NotificationsRepository.getManagementUserIds();

      // Expected recipients: 1 (ADMIN), 2 (DIRECTOR), 5 (ADMIN)
      expect(recipientIds).toEqual([1, 2, 5]);
      expect(recipientIds).not.toContain(3); // SALES_MANAGER excluded
      expect(recipientIds).not.toContain(4); // SALES_MANAGER excluded
      expect(recipientIds).not.toContain(6); // FINANCE_MANAGER excluded
    });

    it('strictly excludes inactive ADMIN and DIRECTOR users (is_active = 0 or false)', async () => {
      const mockUsers = [
        { id: 1, name: 'Active Admin', role: 'ADMIN', is_active: 1 },
        { id: 2, name: 'Inactive Admin (0)', role: 'ADMIN', is_active: 0 },
        { id: 3, name: 'Active Director', role: 'DIRECTOR', is_active: 1 },
        { id: 4, name: 'Inactive Director (false)', role: 'DIRECTOR', is_active: false },
        { id: 5, name: 'Inactive Admin (null)', role: 'ADMIN', is_active: null }
      ];

      const mockDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        in: vi.fn((col, vals) => ({
          data: mockUsers.filter(u => vals.includes(u.role)),
          error: null
        }))
      };
      getServiceDB.mockReturnValue(mockDb);

      const recipientIds = await NotificationsRepository.getManagementUserIds();

      expect(recipientIds).toEqual([1, 3]);
      expect(recipientIds).not.toContain(2); // is_active: 0 excluded
      expect(recipientIds).not.toContain(4); // is_active: false excluded
      expect(recipientIds).not.toContain(5); // is_active: null excluded
    });

    it('flexibly handles various truthy representations of is_active (integer 1, boolean true, string "1", string "true")', async () => {
      const mockUsers = [
        { id: 10, role: 'ADMIN', is_active: 1 },          // integer 1 (Postgres default)
        { id: 20, role: 'DIRECTOR', is_active: true },     // boolean true (SQLite / JS)
        { id: 30, role: 'ADMIN', is_active: '1' },        // string '1'
        { id: 40, role: 'DIRECTOR', is_active: 'true' },   // string 'true'
        { id: 50, role: 'ADMIN', is_active: 0 },          // integer 0
        { id: 60, role: 'DIRECTOR', is_active: '0' },      // string '0'
        { id: 70, role: 'ADMIN', is_active: 'false' },    // string 'false'
        { id: 80, role: 'DIRECTOR', is_active: undefined } // undefined
      ];

      const mockDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        in: vi.fn((col, vals) => ({
          data: mockUsers.filter(u => vals.includes(u.role)),
          error: null
        }))
      };
      getServiceDB.mockReturnValue(mockDb);

      const recipientIds = await NotificationsRepository.getManagementUserIds();

      expect(recipientIds).toEqual([10, 20, 30, 40]);
      expect(recipientIds).not.toContain(50);
      expect(recipientIds).not.toContain(60);
      expect(recipientIds).not.toContain(70);
      expect(recipientIds).not.toContain(80);
    });

    it('throws and logs if database query fails', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const mockDb = {
        from: vi.fn().mockReturnThis(),
        select: vi.fn().mockReturnThis(),
        in: vi.fn(() => ({
          data: null,
          error: new Error('Postgres connection pool exhausted')
        }))
      };
      getServiceDB.mockReturnValue(mockDb);

      await expect(NotificationsRepository.getManagementUserIds()).rejects.toThrow('Postgres connection pool exhausted');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to fetch management user IDs:',
        'Postgres connection pool exhausted'
      );

      consoleErrorSpy.mockRestore();
    });
  });

  // =========================================================================
  // SUITE 2: NotificationsService.notifyLeadsControlDigest() Delivery & Deduplication
  // =========================================================================
  describe('2. NotificationsService.notifyLeadsControlDigest()', () => {
    beforeEach(() => {
      // Mock createNotification with deduplication check like real DB
      vi.spyOn(NotificationsRepository, 'createNotification').mockImplementation(async (data) => {
        if (data.dedupe_key) {
          const existing = inMemoryDb.find(n => n.dedupe_key === data.dedupe_key);
          if (existing) return existing;
        }
        const record = {
          id: nextId++,
          user_id: data.user_id,
          type: data.type || data.event_type,
          title: data.title,
          message: data.message,
          entity_type: data.entity_type,
          entity_id: data.entity_id,
          action_url: data.action_url,
          dedupe_key: data.dedupe_key,
          is_read: false,
          created_at: new Date().toISOString()
        };
        inMemoryDb.push(record);
        return record;
      });
    });

    it('creates digest notifications for all active ADMIN and DIRECTOR users', async () => {
      vi.spyOn(NotificationsRepository, 'getManagementUserIds').mockResolvedValue([1, 2, 5]);

      const stats = {
        unassignedCount: 0,
        overdueContactCount: 0,
        stagnantCount: 0,
        overdueTasksCount: 3
      };

      await NotificationsService.notifyLeadsControlDigest(stats, 'EVENING', '2026-10-14');

      expect(inMemoryDb.length).toBe(3);

      // Verify each recipient received notification
      const user1Notif = inMemoryDb.find(n => n.user_id === 1);
      const user2Notif = inMemoryDb.find(n => n.user_id === 2);
      const user5Notif = inMemoryDb.find(n => n.user_id === 5);

      expect(user1Notif).toBeDefined();
      expect(user1Notif.dedupe_key).toBe('LEADS_CONTROL_DIGEST:1:2026-10-14:EVENING');
      expect(user1Notif.type).toBe('LEADS_CONTROL_DIGEST');

      expect(user2Notif).toBeDefined();
      expect(user2Notif.dedupe_key).toBe('LEADS_CONTROL_DIGEST:2:2026-10-14:EVENING');
      expect(user2Notif.title).toBe('Вечерняя сводка контроля лидов');

      expect(user5Notif).toBeDefined();
      expect(user5Notif.dedupe_key).toBe('LEADS_CONTROL_DIGEST:5:2026-10-14:EVENING');
    });

    it('ensures separate dedupe keys for morning and evening periods without collision', async () => {
      vi.spyOn(NotificationsRepository, 'getManagementUserIds').mockResolvedValue([1, 2]);

      const statsMorning = { unassignedCount: 1, overdueContactCount: 0, stagnantCount: 0, overdueTasksCount: 2 };
      const statsEvening = { unassignedCount: 0, overdueContactCount: 0, stagnantCount: 0, overdueTasksCount: 3 };

      // Dispatch morning digest
      await NotificationsService.notifyLeadsControlDigest(statsMorning, 'MORNING', '2026-10-14');
      expect(inMemoryDb.length).toBe(2);

      // Dispatch evening digest on same date
      await NotificationsService.notifyLeadsControlDigest(statsEvening, 'EVENING', '2026-10-14');
      expect(inMemoryDb.length).toBe(4);

      expect(inMemoryDb.map(n => n.dedupe_key)).toEqual([
        'LEADS_CONTROL_DIGEST:1:2026-10-14:MORNING',
        'LEADS_CONTROL_DIGEST:2:2026-10-14:MORNING',
        'LEADS_CONTROL_DIGEST:1:2026-10-14:EVENING',
        'LEADS_CONTROL_DIGEST:2:2026-10-14:EVENING'
      ]);
    });

    it('guarantees zero duplicate notifications on repeated execution for same period', async () => {
      vi.spyOn(NotificationsRepository, 'getManagementUserIds').mockResolvedValue([1, 2, 5]);

      const stats = { unassignedCount: 0, overdueContactCount: 0, stagnantCount: 0, overdueTasksCount: 3 };

      // First run
      await NotificationsService.notifyLeadsControlDigest(stats, 'EVENING', '2026-10-14');
      expect(inMemoryDb.length).toBe(3);

      // Second identical run (e.g. cron retry)
      await NotificationsService.notifyLeadsControlDigest(stats, 'EVENING', '2026-10-14');
      expect(inMemoryDb.length).toBe(3); // Zero duplicate notifications added
    });

    it('does not create any notifications if no active management users exist', async () => {
      vi.spyOn(NotificationsRepository, 'getManagementUserIds').mockResolvedValue([]);

      const stats = { unassignedCount: 0, overdueContactCount: 0, stagnantCount: 0, overdueTasksCount: 3 };
      await NotificationsService.notifyLeadsControlDigest(stats, 'MORNING', '2026-10-15');

      expect(inMemoryDb.length).toBe(0);
    });
  });

  // =========================================================================
  // SUITE 3: Verify isolation of other notification types
  // =========================================================================
  describe('3. Non-digest notification types remain untouched', () => {
    it('resolveRecipients still queries getAdminUserIds and preserves existing behavior', async () => {
      vi.spyOn(NotificationsRepository, 'getAdminUserIds').mockResolvedValue([1, 5]);

      const recipients = await NotificationsService.resolveRecipients(3); // Manager ID 3

      expect(NotificationsRepository.getAdminUserIds).toHaveBeenCalledTimes(1);
      expect(recipients).toEqual([1, 5, 3]); // ADMINs + Responsible Manager
    });
  });
});
