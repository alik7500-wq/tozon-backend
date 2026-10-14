import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ManagerPerformanceService,
  resolveDateRange,
  LOST_REASON_LABELS
} from '../modules/reports/managerPerformance.service.js';
import { AppError } from '../shared/errors/errorHandler.js';

vi.mock('../db/connection.js', () => ({
  getDB: vi.fn(),
  getServiceDB: vi.fn()
}));

import { getDB } from '../db/connection.js';

describe('Sales Automation V1.2 — Manager Performance Analytics Suite', () => {
  let mockSupabase;
  let mockUsers = [];
  let mockLeads = [];
  let mockDeals = [];
  let mockTasks = [];

  beforeEach(() => {
    vi.clearAllMocks();

    mockUsers = [
      { id: 1, name: 'Admin User', email: 'admin@tozon.tj', role: 'ADMIN', is_active: true },
      { id: 2, name: 'Director User', email: 'director@tozon.tj', role: 'DIRECTOR', is_active: true },
      { id: 3, name: 'Dadojon Saidov', email: 'dadojon@tozon.tj', role: 'SALES_MANAGER', is_active: true },
      { id: 4, name: 'Alisher Rahimov', email: 'alisher@tozon.tj', role: 'SALES_MANAGER', is_active: true },
      { id: 5, name: 'Finance User', email: 'finance@tozon.tj', role: 'FINANCE_MANAGER', is_active: true }
    ];

    mockLeads = [];
    mockDeals = [];
    mockTasks = [];

    mockSupabase = {
      from: vi.fn((table) => {
        let isNullCol = null;
        const q = {
          select: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          is: vi.fn((col, val) => {
            isNullCol = col;
            return q;
          }),
          then: (resolve) => {
            if (table === 'users') {
              return resolve({ data: mockUsers, error: null });
            }
            if (table === 'leads') {
              let res = [...mockLeads];
              if (isNullCol === 'archived_at') {
                res = res.filter(l => !l.archived_at);
              }
              return resolve({ data: res, error: null });
            }
            if (table === 'deals') {
              return resolve({ data: mockDeals, error: null });
            }
            if (table === 'tasks') {
              return resolve({ data: mockTasks, error: null });
            }
            return resolve({ data: [], error: null });
          }
        };
        return q;
      })
    };

    getDB.mockReturnValue(mockSupabase);
  });

  describe('1. RBAC & Security Boundary Enforcement', () => {
    it('rejects unauthenticated requests with 401', async () => {
      await expect(ManagerPerformanceService.getPerformanceData({}, null))
        .rejects.toThrow('Пользователь не авторизован');
    });

    it('rejects FINANCE_MANAGER with 403 Forbidden', async () => {
      const financeUser = { id: 5, role: 'FINANCE_MANAGER' };
      await expect(ManagerPerformanceService.getPerformanceData({}, financeUser))
        .rejects.toThrow('Доступ к аналитике эффективности отдела продаж запрещен');
    });

    it('forces SALES_MANAGER to strictly view only own performance', async () => {
      const salesUser = { id: 3, role: 'SALES_MANAGER' };
      const res = await ManagerPerformanceService.getPerformanceData(
        { managerId: 'ALL' },
        salesUser
      );

      expect(res.isRestrictedToSelf).toBe(true);
      expect(res.filter.managerId).toBe('3');
      expect(res.managers).toHaveLength(1);
      expect(res.managers[0].id).toBe(3);
    });

    it('allows ADMIN and DIRECTOR to view all managers or specific manager', async () => {
      const adminUser = { id: 1, role: 'ADMIN' };
      const resAll = await ManagerPerformanceService.getPerformanceData({}, adminUser);
      expect(resAll.isRestrictedToSelf).toBe(false);
      expect(resAll.filter.managerId).toBe('ALL');
      expect(resAll.managers.length).toBeGreaterThan(1);

      const directorUser = { id: 2, role: 'DIRECTOR' };
      const resFiltered = await ManagerPerformanceService.getPerformanceData(
        { managerId: '4' },
        directorUser
      );
      expect(resFiltered.filter.managerId).toBe('4');
      expect(resFiltered.managers).toHaveLength(1);
      expect(resFiltered.managers[0].id).toBe(4);
    });
  });

  describe('2. Date Range Resolution', () => {
    it('correctly resolves today, month, last_month, and custom', () => {
      const today = resolveDateRange('today');
      expect(today.label).toBe('Сегодня');
      expect(today.startDate).toContain('T00:00:00.000Z');

      const month = resolveDateRange('month');
      expect(month.label).toContain('Текущий месяц');
      expect(month.startDate).toMatch(/^\d{4}-\d{2}-01T00:00:00.000Z$/);

      const custom = resolveDateRange('custom', '2026-05-01', '2026-05-31');
      expect(custom.label).toBe('2026-05-01 — 2026-05-31');
      expect(custom.startDate).toBe('2026-05-01T00:00:00.000Z');
      expect(custom.endDate).toBe('2026-05-31T23:59:59.999Z');
    });
  });

  describe('3. Core KPI Engine Calculations', () => {
    it('accurately calculates Verified Signed Deals vs Cancelled Deals', async () => {
      const adminUser = { id: 1, role: 'ADMIN' };

      // Dadojon has:
      // 1 verified signed deal
      // 1 cancelled deal
      // 1 draft deal (status DRAFT)
      mockDeals = [
        {
          id: 101,
          contract_number: 'TP-2026-001',
          lead_id: 10,
          responsible_user_id: 3,
          status: 'SIGNED',
          final_price_minor: 50000000, // 500,000.00
          deal_date: '2026-04-10',
          signed_at: '2026-04-10T10:00:00.000Z',
          cancelled_at: null,
          created_at: '2026-04-01T10:00:00.000Z'
        },
        {
          id: 102,
          contract_number: 'TP-2026-002',
          lead_id: 11,
          responsible_user_id: 3,
          status: 'CANCELLED',
          final_price_minor: 60000000,
          deal_date: '2026-04-15',
          cancelled_at: '2026-04-20T12:00:00.000Z',
          created_at: '2026-04-02T10:00:00.000Z'
        },
        {
          id: 103,
          contract_number: null,
          lead_id: 12,
          responsible_user_id: 3,
          status: 'DRAFT',
          final_price_minor: 40000000,
          created_at: '2026-04-03T10:00:00.000Z'
        }
      ];

      const res = await ManagerPerformanceService.getPerformanceData(
        { period: 'all', managerId: '3' },
        adminUser
      );

      const dadojon = res.managers[0];
      expect(dadojon.kpi.signedDealsCount).toBe(1);
      expect(dadojon.kpi.salesVolume).toBe(500000);
      expect(dadojon.kpi.cancelledDealsCount).toBe(1);
    });

    it('handles cohort conversion safely: 0 leads returns null and "Недостаточно данных"', async () => {
      const adminUser = { id: 1, role: 'ADMIN' };

      // No leads for Alisher (ID 4)
      mockLeads = [];
      mockDeals = [
        {
          id: 201,
          contract_number: 'TP-2026-099',
          lead_id: 99,
          responsible_user_id: 4,
          status: 'SIGNED',
          signed_at: '2026-04-10T10:00:00.000Z',
          cancelled_at: null
        }
      ];

      const res = await ManagerPerformanceService.getPerformanceData(
        { period: 'all', managerId: '4' },
        adminUser
      );

      const alisher = res.managers[0];
      // Zero cohort leads: must NOT divide by zero or yield 2400%
      expect(alisher.kpi.cohortLeadsCount).toBe(0);
      expect(alisher.kpi.cohortConversionRate).toBeNull();
      expect(alisher.kpi.cohortConversionLabel).toBe('Недостаточно данных');
    });

    it('correctly calculates cohort conversion without exceeding 100% when lead has multiple deals', async () => {
      const adminUser = { id: 1, role: 'ADMIN' };

      // Lead 20 has 3 signed deals
      mockLeads = [
        {
          id: 20,
          full_name: 'Multi Deal Lead',
          status: 'WON',
          responsible_user_id: 3,
          created_at: '2026-03-01T10:00:00.000Z',
          deals: [
            { id: 301, status: 'SIGNED', contract_number: 'TP-1', cancelled_at: null },
            { id: 302, status: 'SIGNED', contract_number: 'TP-2', cancelled_at: null },
            { id: 303, status: 'SIGNED', contract_number: 'TP-3', cancelled_at: null }
          ]
        },
        {
          id: 21,
          full_name: 'Unconverted Lead',
          status: 'IN_PROGRESS',
          responsible_user_id: 3,
          created_at: '2026-03-02T10:00:00.000Z',
          deals: []
        }
      ];

      const res = await ManagerPerformanceService.getPerformanceData(
        { period: 'all', managerId: '3' },
        adminUser
      );

      const dadojon = res.managers[0];
      // 2 leads in cohort, 1 unique lead converted -> 50.0%
      expect(dadojon.kpi.cohortLeadsCount).toBe(2);
      expect(dadojon.kpi.cohortConversionRate).toBe(50.0);
      expect(dadojon.kpi.cohortConversionLabel).toBe('50%');
    });

    it('does NOT count WON lead without deal as a verified signed deal', async () => {
      const adminUser = { id: 1, role: 'ADMIN' };

      // Lead marked as WON manually but has no deals in deals table
      mockLeads = [
        {
          id: 30,
          full_name: 'Ghost Won Lead',
          status: 'WON',
          responsible_user_id: 3,
          created_at: '2026-04-01T10:00:00.000Z',
          deals: []
        }
      ];
      mockDeals = [];

      const res = await ManagerPerformanceService.getPerformanceData(
        { period: 'all', managerId: '3' },
        adminUser
      );

      const dadojon = res.managers[0];
      expect(dadojon.kpi.signedDealsCount).toBe(0);
      expect(dadojon.kpi.cohortConversionRate).toBe(0);
    });

    it('correctly attributes lead to lead.responsible_user_id and deal to deal.responsible_user_id when different', async () => {
      const adminUser = { id: 1, role: 'ADMIN' };

      // Lead belongs to Dadojon (3), but Deal closed by Alisher (4)
      mockLeads = [
        {
          id: 40,
          full_name: 'Transferred Deal Lead',
          status: 'WON',
          responsible_user_id: 3,
          created_at: '2026-04-01T10:00:00.000Z',
          deals: [
            { id: 401, status: 'SIGNED', contract_number: 'TP-401', cancelled_at: null, responsible_user_id: 4 }
          ]
        }
      ];

      mockDeals = [
        {
          id: 401,
          contract_number: 'TP-401',
          lead_id: 40,
          responsible_user_id: 4,
          status: 'SIGNED',
          final_price_minor: 30000000,
          deal_date: '2026-04-10',
          signed_at: '2026-04-10T10:00:00.000Z',
          cancelled_at: null
        }
      ];

      const res = await ManagerPerformanceService.getPerformanceData(
        { period: 'all' },
        adminUser
      );

      const dadojon = res.managers.find(m => m.id === 3);
      const alisher = res.managers.find(m => m.id === 4);

      // Deal volume and count belongs strictly to Alisher (deal closer)
      expect(alisher.kpi.signedDealsCount).toBe(1);
      expect(alisher.kpi.salesVolume).toBe(300000);
      expect(dadojon.kpi.signedDealsCount).toBe(0);

      // Lead belongs to Dadojon
      expect(dadojon.kpi.newLeadsPeriod).toBe(1);
      expect(alisher.kpi.newLeadsPeriod).toBe(0);
    });

    it('calculates task discipline and on-time vs late vs overdue', async () => {
      const adminUser = { id: 1, role: 'ADMIN' };

      mockTasks = [
        {
          id: 501,
          assigned_user_id: 3,
          status: 'COMPLETED',
          due_date: '2026-04-10',
          completed_at: '2026-04-09T15:00:00.000Z' // On time
        },
        {
          id: 502,
          assigned_user_id: 3,
          status: 'COMPLETED',
          due_date: '2026-04-10',
          completed_at: '2026-04-12T10:00:00.000Z' // Late
        },
        {
          id: 503,
          assigned_user_id: 3,
          status: 'OPEN',
          due_date: '2020-01-01' // Long overdue
        }
      ];

      const res = await ManagerPerformanceService.getPerformanceData(
        { period: 'all', managerId: '3' },
        adminUser
      );

      const dadojon = res.managers[0];
      expect(dadojon.kpi.tasksCompletedOnTime).toBe(1);
      expect(dadojon.kpi.tasksCompletedLate).toBe(1);
      expect(dadojon.kpi.tasksCurrentlyOverdue).toBe(1);
      // Total audited = 1 on-time + 1 late + 1 overdue = 3. Discipline = 1 / 3 = 33.3%
      expect(dadojon.kpi.taskDisciplineRate).toBe(33.3);
      expect(dadojon.kpi.taskDisciplineLabel).toBe('33.3%');
    });

    it('aggregates lost reasons breakdown and sorts descending', async () => {
      const adminUser = { id: 1, role: 'ADMIN' };

      mockLeads = [
        { id: 61, status: 'LOST', lost_reason: 'PRICE', responsible_user_id: 3, created_at: '2026-04-01T10:00:00.000Z' },
        { id: 62, status: 'LOST', lost_reason: 'PRICE', responsible_user_id: 3, created_at: '2026-04-01T10:00:00.000Z' },
        { id: 63, status: 'LOST', lost_reason: 'LOCATION', responsible_user_id: 3, created_at: '2026-04-01T10:00:00.000Z' }
      ];

      const res = await ManagerPerformanceService.getPerformanceData(
        { period: 'all', managerId: '3' },
        adminUser
      );

      const dadojon = res.managers[0];
      expect(dadojon.kpi.lostLeadsCount).toBe(3);
      expect(dadojon.kpi.lostReasonsBreakdown).toHaveLength(2);
      expect(dadojon.kpi.lostReasonsBreakdown[0].code).toBe('PRICE');
      expect(dadojon.kpi.lostReasonsBreakdown[0].count).toBe(2);
      expect(dadojon.kpi.lostReasonsBreakdown[0].pct).toBe(66.7);
      expect(dadojon.kpi.lostReasonsBreakdown[1].code).toBe('LOCATION');
      expect(dadojon.kpi.lostReasonsBreakdown[1].count).toBe(1);
      expect(dadojon.kpi.lostReasonsBreakdown[1].pct).toBe(33.3);
    });

    it('calculates unassigned active leads share accurately', async () => {
      const adminUser = { id: 1, role: 'ADMIN' };

      mockLeads = [
        { id: 71, status: 'NEW', responsible_user_id: null },
        { id: 72, status: 'IN_PROGRESS', responsible_user_id: null },
        { id: 73, status: 'NEGOTIATION', responsible_user_id: 3 },
        { id: 74, status: 'WON', responsible_user_id: null } // WON is closed, not active
      ];

      const res = await ManagerPerformanceService.getPerformanceData({}, adminUser);
      // Active = NEW (71), IN_PROGRESS (72), NEGOTIATION (73) = 3 total. Unassigned = 2.
      // 2 / 3 = 66.7%
      expect(res.systemWide.activeLeadsTotal).toBe(3);
      expect(res.systemWide.unassignedActiveLeads).toBe(2);
      expect(res.systemWide.unassignedRatio).toBe(66.7);
    });
  });
});
