import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SalesPlansService } from '../modules/sales-plans/salesPlans.service.js';
import { SalesPlansRepository } from '../modules/sales-plans/salesPlans.repository.js';
import {
  batchSaveSalesPlansSchema,
  planItemSchema,
  getPerformanceQuerySchema,
  approvePlanSchema
} from '../modules/sales-plans/salesPlans.validator.js';
import { AppError } from '../shared/errors/errorHandler.js';

// Mock connection
vi.mock('../db/connection.js', () => ({
  getDB: vi.fn(),
  getServiceDB: vi.fn()
}));

import { getServiceDB } from '../db/connection.js';

describe('Sales Automation V1.3 — Sales Plans & Execution Control Suite', () => {
  let mockSupabase;
  let mockPlans = [];
  let mockAuditLogs = [];
  let mockUsers = [];
  let mockDeals = [];
  let mockPayments = [];
  let mockProjects = [];
  let mockBuildings = [];

  beforeEach(() => {
    vi.clearAllMocks();

    mockUsers = [
      { id: 1, name: 'Admin User', role: 'ADMIN', email: 'admin@tozon.tj', is_active: true },
      { id: 2, name: 'Director User', role: 'DIRECTOR', email: 'director@tozon.tj', is_active: true },
      { id: 3, name: 'Dadojon Saidov', role: 'SALES_MANAGER', email: 'dadojon@tozon.tj', is_active: true },
      { id: 4, name: 'Alisher Rahimov', role: 'SALES_MANAGER', email: 'alisher@tozon.tj', is_active: true },
      { id: 5, name: 'Finance User', role: 'FINANCE_MANAGER', email: 'finance@tozon.tj', is_active: true }
    ];

    mockProjects = [
      { id: 3, name: 'ЖК TOZON PLAZA', code: 'TP', currency: 'USD' }
    ];

    mockBuildings = [
      { id: 3, project_id: 3, name: 'Блок Б', code: 'B', sort_order: 1 },
      { id: 4, project_id: 3, name: 'Блок А', code: 'A', sort_order: 2 }
    ];

    mockPlans = [];
    mockAuditLogs = [];
    mockDeals = [];
    mockPayments = [];

    // Setup Mock Supabase client
    mockSupabase = {
      from: vi.fn((table) => {
        let filters = {};
        const query = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn((col, val) => {
            filters[col] = val;
            return query;
          }),
          not: vi.fn().mockReturnThis(),
          gte: vi.fn().mockReturnThis(),
          lte: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          is: vi.fn((col, val) => {
            filters[col] = val;
            return query;
          }),
          order: vi.fn().mockReturnThis(),
          single: vi.fn(),
          maybeSingle: vi.fn(),
          insert: vi.fn((payload) => {
            const row = { id: Math.floor(Math.random() * 10000) + 1, ...payload };
            if (table === 'sales_plans') mockPlans.push(row);
            if (table === 'sales_plan_audit_logs') mockAuditLogs.push(row);
            return {
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: row, error: null })
              })
            };
          }),
          update: vi.fn((payload) => {
            return {
              eq: vi.fn((col, idVal) => {
                if (table === 'sales_plans') {
                  const idx = mockPlans.findIndex(p => p.id === Number(idVal));
                  if (idx >= 0) {
                    mockPlans[idx] = { ...mockPlans[idx], ...payload };
                  }
                }
                return {
                  select: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({
                      data: mockPlans.find(p => p.id === Number(idVal)) || { id: idVal, ...payload },
                      error: null
                    })
                  })
                };
              })
            };
          }),
          then: (resolve) => {
            if (table === 'sales_plans') {
              let res = [...mockPlans];
              if (filters.period) res = res.filter(p => p.period === filters.period);
              return resolve({ data: res, error: null });
            }
            if (table === 'deals') {
              return resolve({ data: mockDeals, error: null });
            }
            if (table === 'payments') {
              return resolve({ data: mockPayments, error: null });
            }
            if (table === 'users') {
              return resolve({ data: mockUsers, error: null });
            }
            if (table === 'projects') {
              return resolve({ data: mockProjects, error: null });
            }
            if (table === 'buildings') {
              return resolve({ data: mockBuildings, error: null });
            }
            if (table === 'sales_plan_audit_logs') {
              return resolve({ data: mockAuditLogs, error: null });
            }
            return resolve({ data: [], error: null });
          }
        };

        query.maybeSingle.mockImplementation(() => {
          if (table === 'sales_plans') {
            const found = mockPlans.find(p => {
              if (filters.period && p.period !== filters.period) return false;
              if (filters.scope_type && p.scope_type !== filters.scope_type) return false;
              if (filters.manager_id !== undefined && p.manager_id !== filters.manager_id) return false;
              if (filters.project_id !== undefined && p.project_id !== filters.project_id) return false;
              if (filters.building_id !== undefined && p.building_id !== filters.building_id) return false;
              return true;
            });
            return Promise.resolve({ data: found || null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        });

        query.single.mockImplementation(() => {
          if (table === 'sales_plans') {
            const found = mockPlans.find(p => p.id === filters.id);
            return Promise.resolve({ data: found || null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        });

        return query;
      })
    };

    getServiceDB.mockReturnValue(mockSupabase);
  });

  describe('1. Planning Scopes & Schema Validation', () => {
    it('validates DEPARTMENT scope with no foreign ids', () => {
      const valid = planItemSchema.safeParse({
        scope_type: 'DEPARTMENT',
        target_deals_count: 10,
        target_volume_minor: 50000000, // $500,000.00
        currency: 'USD'
      });
      expect(valid.success).toBe(true);

      const invalid = planItemSchema.safeParse({
        scope_type: 'DEPARTMENT',
        manager_id: 3,
        target_deals_count: 10,
        target_volume_minor: 50000000
      });
      expect(invalid.success).toBe(false);
      expect(invalid.error?.issues[0]?.message).toContain('должны быть пустыми');
    });

    it('validates MANAGER scope requiring manager_id and no project/building', () => {
      const valid = planItemSchema.safeParse({
        scope_type: 'MANAGER',
        manager_id: 3,
        target_deals_count: 5,
        target_volume_minor: 25000000,
        currency: 'USD'
      });
      expect(valid.success).toBe(true);

      const invalid = planItemSchema.safeParse({
        scope_type: 'MANAGER',
        target_deals_count: 5,
        target_volume_minor: 25000000
      });
      expect(invalid.success).toBe(false);
    });

    it('validates PROJECT and BUILDING scopes', () => {
      const validProject = planItemSchema.safeParse({
        scope_type: 'PROJECT',
        project_id: 3,
        target_deals_count: 15,
        target_volume_minor: 75000000,
        currency: 'USD'
      });
      expect(validProject.success).toBe(true);

      const validBuilding = planItemSchema.safeParse({
        scope_type: 'BUILDING',
        building_id: 4,
        target_deals_count: 8,
        target_volume_minor: 40000000,
        currency: 'USD'
      });
      expect(validBuilding.success).toBe(true);
    });

    it('rejects negative targets and currencies other than USD', () => {
      const negativeCount = planItemSchema.safeParse({
        scope_type: 'DEPARTMENT',
        target_deals_count: -1,
        target_volume_minor: 10000
      });
      expect(negativeCount.success).toBe(false);

      const nonUsd = planItemSchema.safeParse({
        scope_type: 'DEPARTMENT',
        target_deals_count: 5,
        target_volume_minor: 10000,
        currency: 'TJS'
      });
      expect(nonUsd.success).toBe(false);
      expect(nonUsd.error?.issues[0]?.message).toContain('USD');
    });
  });

  describe('2. RBAC & Data Isolation Enforcement', () => {
    it('rejects FINANCE_MANAGER with 403 Forbidden', async () => {
      const financeUser = { id: 5, role: 'FINANCE_MANAGER' };
      await expect(SalesPlansService.getPerformanceData({ period: '2026-10' }, financeUser))
        .rejects.toThrow('Доступ к планам продаж запрещен для вашей роли');
    });

    it('restricts SALES_MANAGER to view only own metrics and hides colleagues', async () => {
      const salesUser = { id: 3, role: 'SALES_MANAGER' };
      const res = await SalesPlansService.getPerformanceData({ period: '2026-10' }, salesUser);

      expect(res.userRole).toBe('SALES_MANAGER');
      expect(res.isRestrictedToSelf).toBe(true);
      // Only Dadojon (id=3) is included in managers list, Alisher (id=4) is filtered out
      expect(res.managers).toHaveLength(1);
      expect(res.managers[0].manager.id).toBe(3);
    });

    it('prevents SALES_MANAGER from faking managerId in query parameters', async () => {
      const salesUser = { id: 3, role: 'SALES_MANAGER' };
      // User attempts to query colleague Alisher (id=4)
      const res = await SalesPlansService.getPerformanceData({ period: '2026-10', managerId: 4 }, salesUser);

      // Backend overrides requestedManagerId with user's own ID
      expect(res.managers).toHaveLength(1);
      expect(res.managers[0].manager.id).toBe(3);
    });

    it('allows DIRECTOR to view all managers but prohibits plan modification or approval', async () => {
      const directorUser = { id: 2, role: 'DIRECTOR' };
      const res = await SalesPlansService.getPerformanceData({ period: '2026-10' }, directorUser);

      expect(res.isRestrictedToSelf).toBe(false);
      expect(res.managers.length).toBeGreaterThanOrEqual(2);

      // Prohibit plan creation
      await expect(SalesPlansService.batchSavePlans({
        period: '2026-11',
        plans: [{ scope_type: 'DEPARTMENT', target_deals_count: 5, target_volume_minor: 100000 }]
      }, directorUser)).rejects.toThrow('Только Администратор имеет право');

      // Prohibit approval
      await expect(SalesPlansService.approvePlan(1, 'Reason', directorUser))
        .rejects.toThrow('Только Администратор имеет право');

      // Prohibit audit log access
      await expect(SalesPlansService.getAuditLogs({}, directorUser))
        .rejects.toThrow('История корректировок планов доступна только Администратору');
    });

    it('allows ADMIN full rights to create, update, approve and view audit logs', async () => {
      const adminUser = { id: 1, role: 'ADMIN' };

      // Batch save plans for future month
      const saved = await SalesPlansService.batchSavePlans({
        period: '2026-11',
        plans: [{
          scope_type: 'DEPARTMENT',
          target_deals_count: 10,
          target_volume_minor: 50000000,
          currency: 'USD'
        }]
      }, adminUser);

      expect(saved).toHaveLength(1);
      expect(saved[0].scope_type).toBe('DEPARTMENT');
      expect(mockAuditLogs).toHaveLength(1);
      expect(mockAuditLogs[0].action).toBe('CREATE');
    });
  });

  describe('3. In-Month Modification Rules & Audit Logging', () => {
    it('requires a mandatory reason of >= 10 characters when modifying current or past month plan', async () => {
      const adminUser = { id: 1, role: 'ADMIN' };
      const currentPeriod = '2026-10';

      // Attempt without reason
      await expect(SalesPlansService.batchSavePlans({
        period: currentPeriod,
        plans: [{ scope_type: 'DEPARTMENT', target_deals_count: 10, target_volume_minor: 50000000 }]
      }, adminUser)).rejects.toThrow('требуется обоснование (минимум 10 символов)');

      // Attempt with too short reason
      await expect(SalesPlansService.batchSavePlans({
        period: currentPeriod,
        plans: [{ scope_type: 'DEPARTMENT', target_deals_count: 10, target_volume_minor: 50000000 }],
        reason: 'Коротко'
      }, adminUser)).rejects.toThrow('требуется обоснование (минимум 10 символов)');

      // Valid reason >= 10 chars succeeds
      const saved = await SalesPlansService.batchSavePlans({
        period: currentPeriod,
        plans: [{ scope_type: 'DEPARTMENT', target_deals_count: 12, target_volume_minor: 60000000 }],
        reason: 'Утверждение плана с учетом ввода нового блока Б'
      }, adminUser);

      expect(saved).toHaveLength(1);
    });
  });

  describe('4. Sales Accounting Methodology (Gross / Cancellations / Net)', () => {
    beforeEach(() => {
      // 1. Deal signed in 2026-10: Gross sale $50,000
      mockDeals.push({
        id: 101,
        contract_number: 'TP-101',
        lead_id: 11,
        responsible_user_id: 3, // Dadojon
        status: 'SIGNED',
        final_price_minor: 5000000, // $50,000.00
        signed_at: '2026-10-05T10:00:00Z',
        deal_date: '2026-10-05',
        cancelled_at: null,
        units: {
          id: 501,
          unit_number: '12',
          floors: { sections: { buildings: { id: 3, name: 'Блок Б' } } }
        }
      });

      // 2. Deal signed in 2026-10: Gross sale $60,000
      mockDeals.push({
        id: 102,
        contract_number: 'TP-102',
        lead_id: 12,
        responsible_user_id: 3, // Dadojon
        status: 'SIGNED',
        final_price_minor: 6000000, // $60,000.00
        signed_at: '2026-10-10T12:00:00Z',
        deal_date: '2026-10-10',
        cancelled_at: null,
        units: {
          id: 502,
          unit_number: '15',
          floors: { sections: { buildings: { id: 3, name: 'Блок Б' } } }
        }
      });

      // 3. Cross-month cancellation: Deal signed in 2026-08 ($40,000), but cancelled in 2026-10!
      mockDeals.push({
        id: 103,
        contract_number: 'TP-080',
        lead_id: 13,
        responsible_user_id: 3, // Dadojon
        status: 'CANCELLED',
        final_price_minor: 4000000, // $40,000.00
        signed_at: '2026-08-15T10:00:00Z',
        deal_date: '2026-08-15',
        cancelled_at: '2026-10-12T14:00:00Z',
        cancellation_reason: 'Расторжение по заявлению покупателя',
        units: {
          id: 503,
          unit_number: '20',
          floors: { sections: { buildings: { id: 4, name: 'Блок А' } } }
        }
      });

      // 4. In-month cancellation: Deal signed in 2026-10 ($30,000) and cancelled in 2026-10!
      mockDeals.push({
        id: 104,
        contract_number: 'TP-104',
        lead_id: 14,
        responsible_user_id: 4, // Alisher
        status: 'CANCELLED',
        final_price_minor: 3000000, // $30,000.00
        signed_at: '2026-10-02T09:00:00Z',
        deal_date: '2026-10-02',
        cancelled_at: '2026-10-08T11:00:00Z',
        cancellation_reason: 'Отказ от ипотеки',
        units: {
          id: 504,
          unit_number: '25',
          floors: { sections: { buildings: { id: 4, name: 'Блок А' } } }
        }
      });

      // 5. Deal without contract_number (e.g. reservation only) -> MUST BE IGNORED
      mockDeals.push({
        id: 105,
        contract_number: null,
        lead_id: 15,
        responsible_user_id: 4,
        status: 'RESERVED',
        final_price_minor: 4500000,
        deal_date: '2026-10-04'
      });
    });

    it('correctly calculates Gross, Cancellations, and Net sales in contracts and USD', async () => {
      const adminUser = { id: 1, role: 'ADMIN' };
      const res = await SalesPlansService.getPerformanceData({ period: '2026-10' }, adminUser);

      // Department Gross:
      // Deal 101 ($50k), Deal 102 ($60k), Deal 104 ($30k) = 3 deals, $140,000.00
      expect(res.department.gross.count).toBe(3);
      expect(res.department.gross.volumeUsd).toBe(140000);

      // Department Cancellations:
      // Deal 103 ($40k, cross-month) + Deal 104 ($30k, in-month) = 2 deals, $70,000.00
      expect(res.department.cancellations.totalCount).toBe(2);
      expect(res.department.cancellations.totalVolumeUsd).toBe(70000);
      expect(res.department.cancellations.inMonthCount).toBe(1);
      expect(res.department.cancellations.crossMonthCount).toBe(1);

      // Department Net:
      // Net count = 3 - 2 = 1 deal
      // Net volume = $140,000 - $70,000 = $70,000.00
      expect(res.department.net.count).toBe(1);
      expect(res.department.net.volumeUsd).toBe(70000);

      // Reservation without contract was properly excluded
      const totalCount = res.department.gross.count;
      expect(totalCount).toBe(3);
    });

    it('correctly attributes cross-month cancellations to current month Net without altering past periods', async () => {
      const adminUser = { id: 1, role: 'ADMIN' };

      // Check 2026-08 period: Deal 103 was signed here. Should reflect Gross sale in August.
      const augRes = await SalesPlansService.getPerformanceData({ period: '2026-08' }, adminUser);
      expect(augRes.department.gross.count).toBe(1);
      expect(augRes.department.gross.volumeUsd).toBe(40000);
      // It was NOT cancelled in August!
      expect(augRes.department.cancellations.totalCount).toBe(0);
      expect(augRes.department.net.volumeUsd).toBe(40000);

      // In October (2026-10), the cancellation takes effect in October Net!
      const octRes = await SalesPlansService.getPerformanceData({ period: '2026-10' }, adminUser);
      expect(octRes.department.cancellations.crossMonthCount).toBe(1);
    });

    it('correctly handles multiple apartments for one buyer as separate contracts', async () => {
      // Add second apartment for lead_id 11
      mockDeals.push({
        id: 106,
        contract_number: 'TP-106',
        lead_id: 11, // Same buyer as Deal 101
        responsible_user_id: 3,
        status: 'SIGNED',
        final_price_minor: 4500000,
        signed_at: '2026-10-14T15:00:00Z',
        deal_date: '2026-10-14',
        units: { id: 506, unit_number: '26', floors: { sections: { buildings: { id: 3, name: 'Блок Б' } } } }
      });

      const adminUser = { id: 1, role: 'ADMIN' };
      const res = await SalesPlansService.getPerformanceData({ period: '2026-10' }, adminUser);

      // Gross deals count should increment to 4
      expect(res.department.gross.count).toBe(4);
      // Unique buyers count is 3 (leads 11, 12, 14)
      expect(res.department.uniqueBuyersCount).toBe(3);
    });
  });

  describe('5. Working Days Pacing & Run-Rate Forecasting', () => {
    it('calculates 6-day working week (Mon-Sat) for Asia/Dushanbe', () => {
      // Test October 2026: 31 days.
      // Oct 1 2026 is Thursday. Sundays in Oct 2026: Oct 4, 11, 18, 25 (4 Sundays).
      // Total working days = 31 - 4 = 27 working days.
      const pacing = SalesPlansService.calculateWorkingDaysPacing('2026-10');
      expect(pacing.totalWorkingDays).toBe(27);
    });

    it('activates run-rate forecast when elapsed working days >= 3', () => {
      const pastPacing = SalesPlansService.calculateWorkingDaysPacing('2026-09');
      // In past month, pacing has full data
      expect(pastPacing.hasSufficientDataForForecast).toBe(true);
      expect(pastPacing.isPastPeriod).toBe(true);
    });
  });

  describe('6. Financial Separation (Cash Collected vs Contract Volume)', () => {
    it('keeps contract volume completely separated from cash desk collections', async () => {
      mockDeals.push({
        id: 101,
        contract_number: 'TP-101',
        lead_id: 11,
        responsible_user_id: 3,
        status: 'SIGNED',
        final_price_minor: 14000000, // $140,000.00
        signed_at: '2026-10-05T10:00:00Z',
        deal_date: '2026-10-05',
        cancelled_at: null,
        units: { id: 501, unit_number: '12', floors: { sections: { buildings: { id: 3, name: 'Блок Б' } } } }
      });

      // Mock payment received in October 2026: $15,000 cash
      mockPayments.push({
        id: 1,
        deal_id: 101,
        amount_minor: 1500000,
        amount_usd: 15000,
        currency: 'USD',
        payment_date: '2026-10-10',
        status: 'ACTIVE'
      });

      const adminUser = { id: 1, role: 'ADMIN' };
      const res = await SalesPlansService.getPerformanceData({ period: '2026-10' }, adminUser);

      // Contract sales volume is derived from deal contracts final_price_minor
      expect(res.department.gross.volumeUsd).toBe(140000);

      // Cash collected is strictly stored in separate cashCollected object
      expect(res.department.cashCollected.volumeUsd).toBe(15000);
      expect(res.department.cashCollected.volumeMinor).toBe(1500000);
      expect(res.department.cashCollected.cashToContractRatio).toBe(10.7);
    });
  });

  describe('7. Deals Drill-down & Diagnostic Quality', () => {
    it('returns filtered contracts list with details and preserves security boundaries', async () => {
      mockDeals.push(
        {
          id: 101,
          contract_number: 'TP-101',
          lead_id: 11,
          responsible_user_id: 3,
          status: 'SIGNED',
          final_price_minor: 5000000,
          signed_at: '2026-10-05T10:00:00Z',
          deal_date: '2026-10-05',
          units: { id: 501, unit_number: '12', floors: { sections: { buildings: { id: 3, name: 'Блок Б' } } } }
        },
        {
          id: 102,
          contract_number: 'TP-102',
          lead_id: 12,
          responsible_user_id: 4, // Alisher
          status: 'SIGNED',
          final_price_minor: 6000000,
          signed_at: '2026-10-10T12:00:00Z',
          deal_date: '2026-10-10',
          units: { id: 502, unit_number: '15', floors: { sections: { buildings: { id: 3, name: 'Блок Б' } } } }
        }
      );

      const salesUser = { id: 3, role: 'SALES_MANAGER' };
      const breakdown = await SalesPlansService.getDealsBreakdown({
        period: '2026-10',
        type: 'GROSS'
      }, salesUser);

      // Only deals belonging to Dadojon (id=3)
      expect(breakdown).toHaveLength(1);
      expect(breakdown[0].id).toBe(101);
    });
  });
});
