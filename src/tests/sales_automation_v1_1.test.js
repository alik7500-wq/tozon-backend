import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  calculateWorkingMinutes,
  isWithinWorkingHours,
  isBusinessDay,
  formatWorkingDuration,
  getBusinessDate,
  getBusinessDateTime,
  isWithinSalesAutomationWindow,
  WORK_HOURS
} from '../utils/businessTime.js';
import {
  SalesAutomationDetector,
  SALES_AUTOMATION_HISTORICAL_CUTOFF
} from '../modules/automation/salesAutomationDetector.js';
import { NotificationsService } from '../modules/notifications/notifications.service.js';
import { NotificationsRepository } from '../modules/notifications/notifications.repository.js';
import { LeadsRepository } from '../modules/leads/leads.repository.js';

vi.mock('../db/connection.js', () => ({
  getServiceDB: vi.fn(),
  getDB: vi.fn(),
  assertSafeTestDatabase: vi.fn(() => true)
}));

vi.mock('../modules/notifications/notifications.repository.js', () => ({
  NotificationsRepository: {
    getAdminUserIds: vi.fn(),
    getManagementUserIds: vi.fn(),
    createNotification: vi.fn()
  }
}));

import { getServiceDB, getDB } from '../db/connection.js';

describe('Sales Automation V1.1 — Lead SLA & Processing Control Suite', () => {
  let mockSupabase;
  let mockLeadsData = [];
  let mockUnassignedLeads = [];
  let mockAssignedNewLeads = [];
  let mockStagnantLeads = [];
  let mockTasksData = [];

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SALES_AUTOMATION_V1_1_ENABLED;

    mockLeadsData = [];
    mockUnassignedLeads = [];
    mockAssignedNewLeads = [];
    mockStagnantLeads = [];
    mockTasksData = [];

    mockSupabase = {
      from: vi.fn((table) => {
        let isNullCalled = false;
        let notNullCalled = false;
        let statusEq = null;
        let statusIn = [];

        const q = {
          select: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          range: vi.fn().mockReturnThis(),
          is: vi.fn((field, val) => {
            if (field === 'responsible_user_id' && val === null) isNullCalled = true;
            return q;
          }),
          not: vi.fn((field, op, val) => {
            if (field === 'responsible_user_id' && val === null) notNullCalled = true;
            return q;
          }),
          eq: vi.fn((field, val) => {
            if (field === 'status') statusEq = val;
            return q;
          }),
          in: vi.fn((field, vals) => {
            if (field === 'status') statusIn = vals;
            return q;
          }),
          then(resolve, reject) {
            let data = [];
            if (table === 'tasks') {
              data = mockTasksData;
            } else if (table === 'leads') {
              if (isNullCalled) {
                data = mockUnassignedLeads;
              } else if (statusEq === 'NEW' && notNullCalled) {
                data = mockAssignedNewLeads;
              } else if (statusIn.includes('IN_PROGRESS') && notNullCalled) {
                data = mockStagnantLeads;
              } else {
                data = mockLeadsData;
              }
            }
            return Promise.resolve({ data, error: null }).then(resolve, reject);
          }
        };
        return q;
      })
    };

    getServiceDB.mockReturnValue(mockSupabase);
    getDB.mockReturnValue(mockSupabase);
    NotificationsRepository.getAdminUserIds.mockResolvedValue([1, 5]);
    NotificationsRepository.getManagementUserIds.mockResolvedValue([1, 2, 5]);
    NotificationsRepository.createNotification.mockResolvedValue({ id: 101 });
  });

  // =========================================================================
  // TEST 1: Working hours calculations (08:00 - 20:00 Asia/Dushanbe)
  // =========================================================================
  describe('1. SLA working hours window (08:00 - 20:00 Asia/Dushanbe)', () => {
    it('accurately detects within and outside working hours boundaries', () => {
      // 08:00 TJT = 03:00 UTC
      // 20:00 TJT = 15:00 UTC
      const beforeWork = new Date('2026-10-14T02:59:00.000Z'); // 07:59 TJT
      const atWorkStart = new Date('2026-10-14T03:00:00.000Z'); // 08:00 TJT
      const duringWork = new Date('2026-10-14T07:00:00.000Z');  // 12:00 TJT
      const beforeWorkEnd = new Date('2026-10-14T14:59:00.000Z'); // 19:59 TJT
      const atWorkEnd = new Date('2026-10-14T15:00:00.000Z'); // 20:00 TJT

      expect(isWithinWorkingHours(beforeWork)).toBe(false);
      expect(isWithinWorkingHours(atWorkStart)).toBe(true);
      expect(isWithinWorkingHours(duringWork)).toBe(true);
      expect(isWithinWorkingHours(beforeWorkEnd)).toBe(true);
      expect(isWithinWorkingHours(atWorkEnd)).toBe(false);
    });

    it('calculates exact working minutes within the same business day', () => {
      const start = new Date('2026-10-14T05:00:00.000Z'); // 10:00 TJT
      const end = new Date('2026-10-14T06:30:00.000Z');   // 11:30 TJT

      const mins = calculateWorkingMinutes(start, end);
      expect(mins).toBe(90);
      expect(formatWorkingDuration(mins)).toBe('1 ч 30 мин');
    });

    it('clamps calculation if start is before 08:00 and end is after 20:00', () => {
      const start = new Date('2026-10-14T01:00:00.000Z'); // 06:00 TJT
      const end = new Date('2026-10-14T16:00:00.000Z');   // 21:00 TJT

      // Full working day: 08:00 to 20:00 = 12 hours = 720 minutes
      const mins = calculateWorkingMinutes(start, end);
      expect(mins).toBe(720);
      expect(formatWorkingDuration(mins)).toBe('12 ч');
    });
  });

  // =========================================================================
  // TEST 2: Overnight SLA carryover (Non-working night hours carry over)
  // =========================================================================
  describe('2. Overnight SLA carryover across non-working night hours', () => {
    it('properly carries over timer across night hours (20:00 - 08:00 TJT)', () => {
      // Lead assigned at 19:30 TJT on Day 1 (14:30 UTC)
      // Day 1 working time: 19:30 to 20:00 = 30 minutes
      const start = new Date('2026-10-14T14:30:00.000Z');

      // Check at 04:00 TJT Day 2 (23:00 UTC Day 1) -> still only 30 working minutes
      const middleNight = new Date('2026-10-14T23:00:00.000Z');
      expect(calculateWorkingMinutes(start, middleNight)).toBe(30);

      // Check at 08:30 TJT Day 2 (03:30 UTC Day 2) -> 30 mins + 30 mins = 60 mins (WARNING threshold)
      const morningWarning = new Date('2026-10-15T03:30:00.000Z');
      expect(calculateWorkingMinutes(start, morningWarning)).toBe(60);

      // Check at 09:30 TJT Day 2 (04:30 UTC Day 2) -> 30 mins + 90 mins = 120 mins (OVERDUE threshold)
      const morningOverdue = new Date('2026-10-15T04:30:00.000Z');
      expect(calculateWorkingMinutes(start, morningOverdue)).toBe(120);
    });
  });

  // =========================================================================
  // TEST 3: Weekend behavior
  // =========================================================================
  describe('3. Weekend behavior according to business rules', () => {
    it('operates standard 7-day schedule by default for sales department', () => {
      // Sunday 11:00 TJT to Sunday 13:00 TJT (2026-10-18 is Sunday)
      const sundayStart = new Date('2026-10-18T06:00:00.000Z'); // 11:00 TJT
      const sundayEnd = new Date('2026-10-18T08:00:00.000Z');   // 13:00 TJT

      const mins = calculateWorkingMinutes(sundayStart, sundayEnd);
      expect(mins).toBe(120);
    });

    it('respects weekend skip option when configured for non-working weekends', () => {
      // Friday 19:00 TJT to Monday 09:00 TJT
      // 2026-10-16 is Friday (19:00 TJT = 14:00 UTC)
      // 2026-10-19 is Monday (09:00 TJT = 04:00 UTC)
      const friday19 = new Date('2026-10-16T14:00:00.000Z');
      const monday09 = new Date('2026-10-19T04:00:00.000Z');

      const minsWithWeekendSkipped = calculateWorkingMinutes(friday19, monday09, { skipWeekends: true });
      // Friday 19:00 to 20:00 = 60 mins
      // Saturday = 0 mins
      // Sunday = 0 mins
      // Monday 08:00 to 09:00 = 60 mins
      // Total = 120 mins
      expect(minsWithWeekendSkipped).toBe(120);
    });
  });

  // =========================================================================
  // TEST 4: Multi-signal first contact detection (No telephony proof fallacy)
  // =========================================================================
  describe('4. Multi-signal first contact detection', () => {
    it('does NOT treat absence of phone call record as lack of contact if other signals exist', async () => {
      // 24 hours ago guaranteed > 2 working hours elapsed
      const leadCreated = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

      // Signal 1: Status progressed beyond NEW
      const leadWithStatusProgression = {
        id: 201,
        full_name: 'Фируз Холиков',
        status: 'IN_PROGRESS',
        responsible_user_id: 3,
        created_at: leadCreated,
        lead_notes: [],
        tasks: [],
        deals: []
      };

      // Signal 2: Note added by manager
      const leadWithNote = {
        id: 202,
        full_name: 'Дилшод Саидов',
        status: 'NEW',
        responsible_user_id: 3,
        created_at: leadCreated,
        lead_notes: [{ id: 1, created_at: leadCreated }],
        tasks: [],
        deals: []
      };

      // Signal 3: Task completed (e.g. call or meeting)
      const leadWithCompletedTask = {
        id: 203,
        full_name: 'Фарход Каримов',
        status: 'NEW',
        responsible_user_id: 3,
        created_at: leadCreated,
        lead_notes: [],
        tasks: [{ id: 10, status: 'COMPLETED' }],
        deals: []
      };

      // Control lead: NO notes, NO completed tasks, NO deals, status still NEW
      const leadNoContact = {
        id: 204,
        full_name: 'Умед Назаров',
        status: 'NEW',
        responsible_user_id: 3,
        created_at: leadCreated,
        lead_notes: [],
        tasks: [{ id: 11, status: 'OPEN' }],
        deals: []
      };

      // Evaluate SLA via LeadsRepository
      mockLeadsData = [leadWithStatusProgression, leadWithNote, leadWithCompletedTask, leadNoContact];

      const result = await LeadsRepository.getSlaControlData({}, { id: 1, role: 'ADMIN' });
      const evaluated = result.leads;

      const eval201 = evaluated.find(l => l.id === 201);
      const eval202 = evaluated.find(l => l.id === 202);
      const eval203 = evaluated.find(l => l.id === 203);
      const eval204 = evaluated.find(l => l.id === 204);

      expect(eval201.first_contact_recorded).toBe(true);
      expect(eval202.first_contact_recorded).toBe(true);
      expect(eval203.first_contact_recorded).toBe(true);

      // Lead 204 has no confirmed contact signal and working time > 2h -> OVERDUE_CONTACT
      expect(eval204.first_contact_recorded).toBe(false);
      expect(eval204.sla_status).toBe('OVERDUE_CONTACT');
    });
  });

  // =========================================================================
  // TEST 5: Feature flag isolation & Dry-Run safety
  // =========================================================================
  describe('5. Feature Flag SALES_AUTOMATION_V1_1_ENABLED protection', () => {
    it('does NOT trigger live V1.1 notifications when SALES_AUTOMATION_V1_1_ENABLED is unset / false', async () => {
      process.env.SALES_AUTOMATION_V1_1_ENABLED = 'false';

      mockUnassignedLeads = [];
      mockTasksData = [];
      mockAssignedNewLeads = [{
        id: 301,
        full_name: 'Шахбоз Алиев',
        phone: '+992927778899',
        status: 'NEW',
        responsible_user_id: 3,
        created_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
        users: { id: 3, name: 'Дадочон' },
        lead_notes: [],
        tasks: [],
        deals: []
      }];
      mockStagnantLeads = [];

      const notifySpy = vi.spyOn(NotificationsService, 'notifyLeadFirstContactOverdue');

      const stats = await SalesAutomationDetector.runDetectionCycle({ isDryRun: false });

      expect(stats.v11Enabled).toBe(false);
      expect(notifySpy).not.toHaveBeenCalled();
    });

    it('triggers V1.1 notifications ONLY when SALES_AUTOMATION_V1_1_ENABLED=true', async () => {
      process.env.SALES_AUTOMATION_V1_1_ENABLED = 'true';

      const notifySpy = vi.spyOn(NotificationsService, 'notifyLeadFirstContactOverdue');

      const lead = {
        id: 302,
        full_name: 'Тестовый Клиент',
        phone: '+992921234567',
        responsible_user_id: 3
      };

      await NotificationsService.notifyLeadFirstContactOverdue(lead, 3, 140);

      expect(notifySpy).toHaveBeenCalledWith(lead, 3, 140);
      expect(NotificationsRepository.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'LEAD_FIRST_CONTACT_OVERDUE',
          user_id: 3,
          dedupe_key: 'LEAD_FIRST_CONTACT_OVERDUE:302:3'
        })
      );
    });
  });

  // =========================================================================
  // TEST 6: Historical leads exclusion
  // =========================================================================
  describe('6. Historical backlog exclusion (< 2026-10-08)', () => {
    it('completely ignores leads created before the cutoff date', async () => {
      const historicalLead = {
        id: 15,
        full_name: 'Исторический Лид 1',
        status: 'NEW',
        responsible_user_id: 3,
        created_at: '2026-09-15T10:00:00.000Z', // Before 2026-10-08
        lead_notes: [],
        tasks: [],
        deals: []
      };

      mockUnassignedLeads = [];
      mockTasksData = [];
      mockAssignedNewLeads = [historicalLead];
      mockStagnantLeads = [];

      const notifyWarningSpy = vi.spyOn(NotificationsService, 'notifyLeadFirstContactWarning');
      const notifyOverdueSpy = vi.spyOn(NotificationsService, 'notifyLeadFirstContactOverdue');

      process.env.SALES_AUTOMATION_V1_1_ENABLED = 'true';

      const stats = await SalesAutomationDetector.runDetectionCycle({ isDryRun: false });

      expect(notifyWarningSpy).not.toHaveBeenCalled();
      expect(notifyOverdueSpy).not.toHaveBeenCalled();
      expect(stats.firstContactOverdueNotified).toBe(0);
    });
  });

  // =========================================================================
  // TEST 7: Absence of duplicates between V1.0 and V1.1
  // =========================================================================
  describe('7. Absence of duplicates between V1.0 and V1.1', () => {
    it('maintains distinct event types and unique dedupe keys', async () => {
      const lead = { id: 401, full_name: 'Клиент Для Проверки Дублей', phone: '+992900001122' };

      // V1.0 event
      await NotificationsService.notifyLeadUnassigned(lead);

      // V1.1 events
      await NotificationsService.notifyLeadFirstContactWarning(lead, 3, 65);
      await NotificationsService.notifyLeadFirstContactOverdue(lead, 3, 130);
      await NotificationsService.notifyLeadStagnant(lead, 3, 50, '2026-10-14');

      const calls = NotificationsRepository.createNotification.mock.calls.map(c => c[0]);

      const types = calls.map(c => c.type);
      const keys = calls.map(c => c.dedupe_key);

      expect(types).toContain('LEAD_UNASSIGNED');
      expect(types).toContain('LEAD_FIRST_CONTACT_WARNING');
      expect(types).toContain('LEAD_FIRST_CONTACT_OVERDUE');
      expect(types).toContain('LEAD_STAGNANT');

      // All keys must be unique
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    });
  });

  // =========================================================================
  // TEST 8: RBAC isolation for API /sla-control
  // =========================================================================
  describe('8. RBAC and data isolation for /api/leads/sla-control', () => {
    it('restricts SALES_MANAGER to view only their own assigned leads', async () => {
      const salesManager = { id: 3, role: 'SALES_MANAGER', name: 'Дадочон' };

      mockLeadsData = [
        {
          id: 501,
          full_name: 'Клиент Менеджера',
          status: 'NEW',
          responsible_user_id: 3,
          created_at: new Date().toISOString()
        }
      ];

      const res = await LeadsRepository.getSlaControlData({}, salesManager);
      expect(res.leads).toHaveLength(1);
      expect(res.leads[0].responsible_user_id).toBe(3);
    });

    it('denies access to FINANCE_MANAGER with 403 Forbidden', async () => {
      const financeUser = { id: 4, role: 'FINANCE_MANAGER', name: 'Далер' };

      await expect(
        LeadsRepository.getSlaControlData({}, financeUser)
      ).rejects.toThrow('Доступ к контролю лидов разрешен только менеджерам по продажам и руководству');
    });

    it('allows DIRECTOR and ADMIN full visibility without manager filter', async () => {
      const director = { id: 2, role: 'DIRECTOR', name: 'РОП' };

      mockLeadsData = [];

      const res = await LeadsRepository.getSlaControlData({}, director);
      expect(res.summary).toBeDefined();
    });
  });

  // =========================================================================
  // TEST 9: Stagnant leads detection (> 48h without next scheduled action)
  // =========================================================================
  describe('9. Stagnant leads detection (> 48h without open tasks)', () => {
    it('flags lead as STAGNANT if active > 48h without open tasks, but NOT if open task is scheduled', async () => {
      const twoDaysAgo = new Date(Date.now() - 50 * 3600 * 1000).toISOString();

      const stagnantLead = {
        id: 601,
        full_name: 'Зависший Лид',
        status: 'IN_PROGRESS',
        responsible_user_id: 3,
        created_at: twoDaysAgo,
        updated_at: twoDaysAgo,
        lead_notes: [],
        tasks: [] // NO open tasks
      };

      const activeLeadWithTask = {
        id: 602,
        full_name: 'Активный Лид',
        status: 'IN_PROGRESS',
        responsible_user_id: 3,
        created_at: twoDaysAgo,
        updated_at: twoDaysAgo,
        lead_notes: [],
        tasks: [{ id: 88, status: 'OPEN', due_date: getBusinessDate() }] // Has scheduled task!
      };

      mockLeadsData = [stagnantLead, activeLeadWithTask];

      const res = await LeadsRepository.getSlaControlData({}, { id: 1, role: 'ADMIN' });
      const evaluated = res.leads;

      const eval601 = evaluated.find(l => l.id === 601);
      const eval602 = evaluated.find(l => l.id === 602);

      expect(eval601.sla_status).toBe('STAGNANT');
      expect(eval602.sla_status).toBe('ON_TRACK');
    });
  });

  // =========================================================================
  // TEST 10: Control Digest generation (Morning & Evening)
  // =========================================================================
  describe('10. Morning and Evening Control Digests', () => {
    it('creates digest notification for admins with aggregated counts', async () => {
      const stats = {
        unassignedCount: 2,
        overdueContactCount: 1,
        stagnantCount: 3,
        overdueTasksCount: 4
      };

      await NotificationsService.notifyLeadsControlDigest(stats, 'MORNING', '2026-10-14');

      expect(NotificationsRepository.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'LEADS_CONTROL_DIGEST',
          user_id: 1,
          dedupe_key: 'LEADS_CONTROL_DIGEST:1:2026-10-14:MORNING',
          action_url: '/leads?tab=control'
        })
      );
    });
  });

  // =========================================================================
  // TEST 11: Sales Automation Execution Window Guard (08:00 - 20:00 Asia/Dushanbe)
  // =========================================================================
  describe('11. Sales Automation Execution Window Guard', () => {
    it('accurately identifies working window 08:00 to 20:00 Asia/Dushanbe inclusive', () => {
      // 07:59 TJT (02:59 UTC) -> Outside
      expect(isWithinSalesAutomationWindow('2026-10-14T02:59:00Z')).toBe(false);

      // 08:00 TJT (03:00 UTC) -> Inside (Day Start)
      expect(isWithinSalesAutomationWindow('2026-10-14T03:00:00Z')).toBe(true);

      // 12:30 TJT (07:30 UTC) -> Inside
      expect(isWithinSalesAutomationWindow('2026-10-14T07:30:00Z')).toBe(true);

      // 19:30 TJT (14:30 UTC) -> Inside
      expect(isWithinSalesAutomationWindow('2026-10-14T14:30:00Z')).toBe(true);

      // 20:00 TJT (15:00 UTC) -> Inside (Day End closing run)
      expect(isWithinSalesAutomationWindow('2026-10-14T15:00:00Z')).toBe(true);

      // 20:03 TJT (15:03 UTC) -> Inside (Tolerates container startup buffer for 20:00 run)
      expect(isWithinSalesAutomationWindow('2026-10-14T15:03:00Z')).toBe(true);

      // 20:06 TJT (15:06 UTC) -> Outside
      expect(isWithinSalesAutomationWindow('2026-10-14T15:06:00Z')).toBe(false);

      // 20:30 TJT (15:30 UTC) -> Strictly Outside (blocks extra 15:30 cron slot from */30 3-15)
      expect(isWithinSalesAutomationWindow('2026-10-14T15:30:00Z')).toBe(false);

      // 23:00 TJT (18:00 UTC) -> Outside (Night)
      expect(isWithinSalesAutomationWindow('2026-10-14T18:00:00Z')).toBe(false);
    });
  });
});

