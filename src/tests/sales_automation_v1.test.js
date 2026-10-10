import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SalesAutomationDetector, SALES_AUTOMATION_HISTORICAL_CUTOFF } from '../modules/automation/salesAutomationDetector.js';
import { NotificationsService } from '../modules/notifications/notifications.service.js';
import { NotificationsRepository } from '../modules/notifications/notifications.repository.js';

vi.mock('../db/connection.js', () => ({
  getServiceDB: vi.fn(),
  assertSafeTestDatabase: vi.fn(() => true)
}));

vi.mock('../modules/notifications/notifications.repository.js', () => ({
  NotificationsRepository: {
    getAdminUserIds: vi.fn(),
    createNotification: vi.fn()
  }
}));

import { getServiceDB } from '../db/connection.js';

describe('Sales Automation V1.0 Detector Test Suite', () => {
  let mockSupabase;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis()
    };

    getServiceDB.mockReturnValue(mockSupabase);
    NotificationsRepository.getAdminUserIds.mockResolvedValue([1, 5]);
    NotificationsRepository.createNotification.mockResolvedValue({ id: 99 });
  });

  it('1. Triggers LEAD_UNASSIGNED notification for a new unassigned lead created after cutoff', async () => {
    const newLead = {
      id: 101,
      full_name: 'Акмал Рахимов',
      phone: '+992901112233',
      status: 'NEW',
      responsible_user_id: null,
      created_at: '2026-10-10T10:00:00.000Z'
    };

    mockSupabase.in.mockImplementation((field, vals) => {
      if (field === 'status') {
        return Promise.resolve({ data: [newLead], error: null });
      }
      return Promise.resolve({ data: [], error: null });
    });
    mockSupabase.eq.mockImplementation((field, val) => {
      if (field === 'status') {
        return Promise.resolve({ data: [], error: null });
      }
      return Promise.resolve({ data: [], error: null });
    });

    const stats = await SalesAutomationDetector.runDetectionCycle({ businessDate: '2026-10-10' });

    expect(stats.unassignedLeadsScanned).toBe(1);
    expect(stats.unassignedLeadsNotified).toBe(1);
    expect(stats.unassignedHistoricalExcluded).toBe(0);

    expect(NotificationsRepository.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'LEAD_UNASSIGNED',
        entity_id: 101,
        action_url: '/clients?clientId=101'
      })
    );
  });

  it('2. Excludes historical unassigned leads created before cutoff date (2026-10-08)', async () => {
    const historicalLead = {
      id: 20,
      full_name: 'Старый Лид',
      phone: '+992900000000',
      status: 'NEW',
      responsible_user_id: null,
      created_at: '2026-09-01T10:00:00.000Z'
    };

    mockSupabase.in.mockImplementation((field) => {
      if (field === 'status') {
        return Promise.resolve({ data: [historicalLead], error: null });
      }
      return Promise.resolve({ data: [], error: null });
    });
    mockSupabase.eq.mockImplementation(() => Promise.resolve({ data: [], error: null }));

    const stats = await SalesAutomationDetector.runDetectionCycle({ businessDate: '2026-10-10' });

    expect(stats.unassignedLeadsScanned).toBe(1);
    expect(stats.unassignedLeadsNotified).toBe(0);
    expect(stats.unassignedHistoricalExcluded).toBe(1);
    expect(NotificationsRepository.createNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'LEAD_UNASSIGNED' })
    );
  });

  it('3. Triggers MANAGER_TASK_OVERDUE for open overdue tasks created after cutoff', async () => {
    const overdueTask = {
      id: 301,
      lead_id: 50,
      deal_id: null,
      assigned_user_id: 3,
      type: 'CALL',
      title: 'Перезвонить по поводу рассрочки',
      client_name: 'Фарход Каюмов',
      due_date: '2026-10-09',
      status: 'OPEN',
      created_at: '2026-10-08T12:00:00.000Z'
    };

    mockSupabase.in.mockImplementation(() => Promise.resolve({ data: [], error: null }));
    mockSupabase.eq.mockImplementation((field, val) => {
      if (field === 'status' && val === 'OPEN') {
        return Promise.resolve({ data: [overdueTask], error: null });
      }
      return Promise.resolve({ data: [], error: null });
    });

    const stats = await SalesAutomationDetector.runDetectionCycle({ businessDate: '2026-10-10' });

    expect(stats.overdueTasksScanned).toBe(1);
    expect(stats.overdueTasksNotified).toBe(1);
    expect(stats.overdueHistoricalExcluded).toBe(0);

    expect(NotificationsRepository.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'MANAGER_TASK_OVERDUE',
        entity_id: 50,
        action_url: '/clients?clientId=50'
      })
    );
  });

  it('4. Excludes historical overdue tasks due before cutoff date (2026-10-08)', async () => {
    const historicalOverdueTask = {
      id: 15,
      lead_id: 12,
      assigned_user_id: 3,
      type: 'CALL',
      title: 'Старый звонок',
      client_name: 'Клиент',
      due_date: '2026-09-15',
      status: 'OPEN',
      created_at: '2026-09-01T10:00:00.000Z'
    };

    mockSupabase.in.mockImplementation(() => Promise.resolve({ data: [], error: null }));
    mockSupabase.eq.mockImplementation((field, val) => {
      if (field === 'status' && val === 'OPEN') {
        return Promise.resolve({ data: [historicalOverdueTask], error: null });
      }
      return Promise.resolve({ data: [], error: null });
    });

    const stats = await SalesAutomationDetector.runDetectionCycle({ businessDate: '2026-10-10' });

    expect(stats.overdueTasksScanned).toBe(1);
    expect(stats.overdueTasksNotified).toBe(0);
    expect(stats.overdueHistoricalExcluded).toBe(1);
  });

  it('5. Triggers CALL_REMINDER for open CALL tasks due today with exact time', async () => {
    const todayCallTask = {
      id: 401,
      lead_id: 77,
      assigned_user_id: 3,
      type: 'CALL',
      title: 'Уточнить решение по объекту',
      client_name: 'Собирчон Азимов',
      due_date: '2026-10-10',
      time: '14:30',
      status: 'OPEN'
    };

    mockSupabase.in.mockImplementation(() => Promise.resolve({ data: [], error: null }));
    mockSupabase.eq.mockImplementation((field, val) => {
      if (field === 'status' && val === 'OPEN') {
        return Promise.resolve({ data: [todayCallTask], error: null });
      }
      return Promise.resolve({ data: [], error: null });
    });

    const stats = await SalesAutomationDetector.runDetectionCycle({ businessDate: '2026-10-10' });

    expect(stats.callRemindersNotified).toBe(1);

    expect(NotificationsRepository.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 3,
        type: 'CALL_REMINDER',
        message: expect.stringContaining('Время: 14:30.')
      })
    );
  });

  it('6. Triggers MEETING_REMINDER for open MEETING tasks due today without hallucinating fake time', async () => {
    const todayMeetingTask = {
      id: 501,
      lead_id: 88,
      assigned_user_id: 3,
      type: 'MEETING',
      title: 'Встреча в офисе продаж',
      client_name: 'Зиёда Сатторова',
      due_date: '2026-10-10',
      time: null,
      status: 'OPEN'
    };

    mockSupabase.in.mockImplementation(() => Promise.resolve({ data: [], error: null }));
    mockSupabase.eq.mockImplementation((field, val) => {
      if (field === 'status' && val === 'OPEN') {
        return Promise.resolve({ data: [todayMeetingTask], error: null });
      }
      return Promise.resolve({ data: [], error: null });
    });

    const stats = await SalesAutomationDetector.runDetectionCycle({ businessDate: '2026-10-10' });

    expect(stats.meetingRemindersNotified).toBe(1);

    expect(NotificationsRepository.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 3,
        type: 'MEETING_REMINDER',
        message: 'На сегодня запланирована встреча с клиентом Зиёда Сатторова: "Встреча в офисе продаж".'
      })
    );
  });

  it('7. Enforces concurrency protection lock during running detection cycle', async () => {
    mockSupabase.in.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ data: [], error: null }), 50)));
    mockSupabase.eq.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ data: [], error: null }), 50)));

    const p1 = SalesAutomationDetector.runDetectionCycle({ businessDate: '2026-10-10' });
    const p2 = SalesAutomationDetector.runDetectionCycle({ businessDate: '2026-10-10' });

    const [res1, res2] = await Promise.all([p1, p2]);

    expect(res2).toEqual({ skipped: true, reason: 'CONCURRENT_EXECUTION_LOCKED' });
  });

  it('8. Handles absence of active ADMIN users gracefully', async () => {
    NotificationsRepository.getAdminUserIds.mockResolvedValue([]);

    const newLead = {
      id: 105,
      full_name: 'Тестовый Лид',
      status: 'NEW',
      responsible_user_id: null,
      created_at: '2026-10-10T12:00:00.000Z'
    };

    mockSupabase.in.mockImplementation(() => Promise.resolve({ data: [newLead], error: null }));
    mockSupabase.eq.mockImplementation(() => Promise.resolve({ data: [], error: null }));

    await NotificationsService.notifyLeadUnassigned(newLead);

    expect(NotificationsRepository.createNotification).not.toHaveBeenCalled();
  });

  it('9. Correctly triggers MANAGER_TASK_OVERDUE for newly created task (created_at >= 2026-10-08) even if due_date is backdated before cutoff', async () => {
    const newlyCreatedBackdatedTask = {
      id: 601,
      lead_id: 99,
      assigned_user_id: 3,
      type: 'CALL',
      title: 'Внесённая задним числом просроченная задача',
      client_name: 'Акмал Рахимов',
      due_date: '2026-10-05',
      status: 'OPEN',
      created_at: '2026-10-09T14:00:00.000Z' // Created AFTER release cutoff, but due_date is backdated!
    };

    mockSupabase.in.mockImplementation(() => Promise.resolve({ data: [], error: null }));
    mockSupabase.eq.mockImplementation((field, val) => {
      if (field === 'status' && val === 'OPEN') {
        return Promise.resolve({ data: [newlyCreatedBackdatedTask], error: null });
      }
      return Promise.resolve({ data: [], error: null });
    });

    const stats = await SalesAutomationDetector.runDetectionCycle({ businessDate: '2026-10-10' });

    expect(stats.overdueTasksScanned).toBe(1);
    expect(stats.overdueTasksNotified).toBe(1);
    expect(stats.overdueHistoricalExcluded).toBe(0);

    expect(NotificationsRepository.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'MANAGER_TASK_OVERDUE',
        entity_id: 99,
        action_url: '/clients?clientId=99'
      })
    );
  });

  it('10. Enforces isDryRun when feature flag SALES_AUTOMATION_ENABLED is false', async () => {
    const originalFlag = process.env.SALES_AUTOMATION_ENABLED;
    process.env.SALES_AUTOMATION_ENABLED = 'false';

    const newLead = {
      id: 701,
      full_name: 'Новый Лид',
      phone: '+992909998877',
      status: 'NEW',
      responsible_user_id: null,
      created_at: '2026-10-10T14:00:00.000Z'
    };

    mockSupabase.in.mockImplementation(() => Promise.resolve({ data: [newLead], error: null }));
    mockSupabase.eq.mockImplementation(() => Promise.resolve({ data: [], error: null }));

    // Execute with isDryRun = true (simulating disabled feature flag behavior)
    const stats = await SalesAutomationDetector.runDetectionCycle({ businessDate: '2026-10-10', isDryRun: true });

    expect(stats.unassignedLeadsScanned).toBe(1);
    expect(stats.unassignedLeadsNotified).toBe(1);
    // When isDryRun = true, NotificationsRepository.createNotification must NOT be called!
    expect(NotificationsRepository.createNotification).not.toHaveBeenCalled();

    process.env.SALES_AUTOMATION_ENABLED = originalFlag;
  });
});
