import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SalesAnalyticsService, LOST_REASON_LABELS } from '../modules/reports/salesAnalytics.service.js';
import { AppError } from '../shared/errors/errorHandler.js';

// Mock connection
vi.mock('../db/connection.js', () => ({
  getDB: vi.fn(),
  getServiceDB: vi.fn()
}));

import { getDB, getServiceDB } from '../db/connection.js';

describe('Sales Launch Phase 3.5 — Sales Analytics, Performance & Demand Suite', () => {
  let mockDB;
  let mockPlans = [];
  let mockDeals = [];
  let mockLeads = [];
  let mockTasks = [];
  let mockUsers = [];
  let mockInterests = [];

  const adminUser = { id: 1, role: 'ADMIN', name: 'Admin User', is_active: 1 };
  const directorUser = { id: 2, role: 'DIRECTOR', name: 'Director User', is_active: 1 };
  const salesUser1 = { id: 3, role: 'SALES_MANAGER', name: 'Dadojon Saidov', is_active: 1 };
  const salesUser2 = { id: 4, role: 'SALES_MANAGER', name: 'Alisher Rahimov', is_active: 1 };
  const financeUser = { id: 5, role: 'FINANCE_MANAGER', name: 'Finance User', is_active: 1 };

  beforeEach(() => {
    vi.clearAllMocks();

    mockUsers = [adminUser, directorUser, salesUser1, salesUser2, financeUser];

    // Mock Sales Plans: DEPARTMENT, PROJECT, BUILDING tier representations for 2026-11
    mockPlans = [
      {
        id: 1,
        period: '2026-11',
        scope_type: 'DEPARTMENT',
        target_deals_count: 10,
        target_volume_minor: 35000000, // $350,000
        currency: 'USD',
        status: 'APPROVED'
      },
      {
        id: 2,
        period: '2026-11',
        scope_type: 'PROJECT',
        project_id: 3,
        target_deals_count: 10,
        target_volume_minor: 35000000, // $350,000
        currency: 'USD',
        status: 'APPROVED'
      },
      {
        id: 3,
        period: '2026-11',
        scope_type: 'BUILDING',
        building_id: 3,
        target_deals_count: 10,
        target_volume_minor: 35000000, // $350,000
        currency: 'USD',
        status: 'APPROVED'
      }
    ];

    // Mock Deals: Aug (12), Sep (14), Oct (10 SIGNED, 5 RESERVED, 6 CANCELLED)
    mockDeals = [
      // 2026-08 (12 SIGNED)
      ...Array.from({ length: 12 }, (_, i) => ({
        id: 100 + i,
        contract_number: `TP-08-${i + 1}`,
        status: 'SIGNED',
        payment_type: 'INSTALLMENT',
        final_price_minor: 3200000, // $32,000
        deal_date: '2026-08-10',
        signed_at: '2026-08-15',
        responsible_user_id: 3,
        lead_id: 10 + i,
        unit_id: 50 + i,
        leads: { id: 10 + i, interested_project_id: 3 },
        units: { id: 50 + i, unit_number: String(i + 1), area_m2_x100: 5500, price_per_m2_minor: 70000, floors: { id: 2, floor_number: 2, sections: { id: 3, buildings: { id: 3, project_id: 3 } } } }
      })),
      // 2026-09 (14 SIGNED)
      ...Array.from({ length: 14 }, (_, i) => ({
        id: 200 + i,
        contract_number: `TP-09-${i + 1}`,
        status: 'SIGNED',
        payment_type: 'INSTALLMENT',
        final_price_minor: 3600000, // $36,000
        deal_date: '2026-09-12',
        signed_at: '2026-09-18',
        responsible_user_id: i % 2 === 0 ? 3 : 4,
        lead_id: 20 + i,
        unit_id: 70 + i,
        leads: { id: 20 + i, interested_project_id: 3 },
        units: { id: 70 + i, unit_number: String(20 + i), area_m2_x100: 6000, price_per_m2_minor: 70000, floors: { id: 3, floor_number: 3, sections: { id: 3, buildings: { id: 3, project_id: 3 } } } }
      })),
      // 2026-10 (10 SIGNED, 5 RESERVED, 6 CANCELLED)
      ...Array.from({ length: 10 }, (_, i) => ({
        id: 300 + i,
        contract_number: `TP-10-${i + 1}`,
        status: 'SIGNED',
        payment_type: 'FULL',
        final_price_minor: 3400000, // $34,000
        deal_date: '2026-10-05',
        signed_at: '2026-10-10',
        responsible_user_id: 3,
        lead_id: 40 + i,
        unit_id: 90 + i,
        leads: { id: 40 + i, interested_project_id: 3 },
        units: { id: 90 + i, unit_number: String(40 + i), area_m2_x100: 6500, price_per_m2_minor: 70000, floors: { id: 4, floor_number: 4, sections: { id: 3, buildings: { id: 3, project_id: 3 } } } }
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        id: 350 + i,
        contract_number: null,
        status: 'RESERVED',
        payment_type: 'INSTALLMENT',
        final_price_minor: 4000000, // $40,000
        deal_date: '2026-10-12',
        signed_at: null,
        responsible_user_id: 3,
        lead_id: 60 + i,
        unit_id: 110 + i,
        leads: { id: 60 + i, interested_project_id: 3 },
        units: { id: 110 + i, unit_number: String(60 + i), area_m2_x100: 7000, price_per_m2_minor: 70000, floors: { id: 5, floor_number: 5, sections: { id: 3, buildings: { id: 3, project_id: 3 } } } }
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        id: 380 + i,
        contract_number: `TP-CANCEL-${i + 1}`,
        status: 'CANCELLED',
        final_price_minor: 3500000,
        deal_date: '2026-10-01',
        signed_at: '2026-10-02',
        cancelled_at: '2026-10-14',
        cancellation_reason: 'CLIENT_REFUSAL',
        responsible_user_id: 1,
        lead_id: 70 + i,
        unit_id: 130 + i,
        leads: { id: 70 + i, interested_project_id: 3 },
        units: { id: 130 + i, unit_number: String(80 + i), area_m2_x100: 5000, price_per_m2_minor: 70000, floors: { id: 2, floor_number: 2, sections: { id: 3, buildings: { id: 3, project_id: 3 } } } }
      }))
    ];

    // Mock Leads
    mockLeads = [
      { id: 1, full_name: 'Lead New 1', status: 'NEW', responsible_user_id: 3, interested_project_id: 3, created_at: '2026-10-01T10:00:00Z', lead_notes: [], tasks: [] },
      { id: 2, full_name: 'Lead InProgress 1', status: 'IN_PROGRESS', responsible_user_id: 3, interested_project_id: 3, created_at: '2026-10-02T10:00:00Z', lead_notes: [{ id: 1 }], tasks: [] },
      { id: 3, full_name: 'Lead Negotiation 1', status: 'NEGOTIATION', responsible_user_id: 3, interested_project_id: 3, created_at: '2026-10-03T10:00:00Z', lead_notes: [], tasks: [{ id: 1 }] },
      { id: 4, full_name: 'Lead Lost 1', status: 'LOST', lost_reason: 'PRICE', responsible_user_id: 3, interested_project_id: 3, created_at: '2026-10-04T10:00:00Z', lead_notes: [], tasks: [] },
      { id: 5, full_name: 'Lead Lost 2', status: 'LOST', lost_reason: 'CHOSE_COMPETITOR', responsible_user_id: 4, interested_project_id: 3, created_at: '2026-10-05T10:00:00Z', lead_notes: [], tasks: [] },
      { id: 10, full_name: 'Lead Won 10', status: 'WON', responsible_user_id: 3, interested_project_id: 3, created_at: '2026-08-01T10:00:00Z', lead_notes: [], tasks: [] }
    ];

    // Mock Tasks
    mockTasks = [
      { id: 1, assigned_user_id: 3, type: 'CALL', status: 'COMPLETED', due_date: '2026-10-10', completed_at: '2026-10-10T12:00:00Z' },
      { id: 2, assigned_user_id: 3, type: 'MEETING', status: 'COMPLETED', due_date: '2026-10-11', completed_at: '2026-10-11T14:00:00Z' },
      { id: 3, assigned_user_id: 3, type: 'CALL', status: 'OPEN', due_date: '2026-10-15' }, // Overdue
      { id: 4, assigned_user_id: 3, type: 'CALL', status: 'OPEN', due_date: '2026-10-25' }, // On track
      { id: 5, assigned_user_id: 4, type: 'CALL', status: 'COMPLETED', due_date: '2026-10-08', completed_at: '2026-10-08T15:00:00Z' }
    ];

    // Mock Interests
    mockInterests = [
      {
        id: 1,
        lead_id: 10,
        unit_id: 90,
        priority: 'HIGH',
        comment: 'Клиент хочет 2-комнатную на 3 этаже',
        leads: { id: 10, full_name: 'Акмал Каримов' },
        units: {
          id: 90,
          unit_number: '18',
          rooms: 2,
          area_m2_x100: 6991, // 69.91 m2
          price_per_m2_minor: 70000, // $700
          manual_total_price_minor: 4893700, // $48,937
          status: 'RESERVED',
          floors: {
            id: 3,
            floor_number: 3,
            sections: { id: 3, buildings: { id: 3, name: 'Блок Б', project_id: 3, projects: { id: 3, name: 'TOZON PLAZA' } } }
          }
        }
      },
      {
        id: 2,
        lead_id: 10, // Same buyer interested in second unit
        unit_id: 91,
        priority: 'MEDIUM',
        comment: 'Альтернатива на 4 этаже',
        leads: { id: 10, full_name: 'Акмал Каримов' },
        units: {
          id: 91,
          unit_number: '25',
          rooms: 3,
          area_m2_x100: 8550, // 85.50 m2
          price_per_m2_minor: 72000,
          manual_total_price_minor: 6156000, // $61,560
          status: 'AVAILABLE',
          floors: {
            id: 4,
            floor_number: 4,
            sections: { id: 3, buildings: { id: 3, name: 'Блок Б', project_id: 3, projects: { id: 3, name: 'TOZON PLAZA' } } }
          }
        }
      },
      {
        id: 3,
        lead_id: 11, // Second buyer
        unit_id: 90, // Also interested in unit 90!
        priority: 'HIGH',
        comment: 'Второй интересант на кв 18',
        leads: { id: 11, full_name: 'Фируз Рахимов' },
        units: {
          id: 90,
          unit_number: '18',
          rooms: 2,
          area_m2_x100: 6991,
          price_per_m2_minor: 70000,
          manual_total_price_minor: 4893700,
          status: 'RESERVED',
          floors: {
            id: 3,
            floor_number: 3,
            sections: { id: 3, buildings: { id: 3, name: 'Блок Б', project_id: 3, projects: { id: 3, name: 'TOZON PLAZA' } } }
          }
        }
      }
    ];

    // Mock DB builder
    mockDB = {
      from: vi.fn((table) => {
        return {
          select: vi.fn(() => ({
            is: vi.fn().mockResolvedValue({
              data: table === 'leads' ? mockLeads : []
            }),
            order: vi.fn().mockResolvedValue({
              data: table === 'users' ? mockUsers : []
            }),
            mockResolvedValue: {
              data: table === 'sales_plans' ? mockPlans :
                    table === 'deals' ? mockDeals :
                    table === 'leads' ? mockLeads :
                    table === 'tasks' ? mockTasks :
                    table === 'users' ? mockUsers :
                    table === 'lead_interested_units' ? mockInterests : []
            },
            then(resolve) {
              const data = table === 'sales_plans' ? mockPlans :
                           table === 'deals' ? mockDeals :
                           table === 'leads' ? mockLeads :
                           table === 'tasks' ? mockTasks :
                           table === 'users' ? mockUsers :
                           table === 'lead_interested_units' ? mockInterests : [];
              resolve({ data, error: null });
            }
          }))
        };
      })
    };

    getDB.mockReturnValue(mockDB);
    getServiceDB.mockReturnValue(mockDB);
  });

  describe('Security & RBAC Enforcement', () => {
    it('throws 401 when user is unauthenticated', async () => {
      await expect(SalesAnalyticsService.getPlanFactAnalytics({}, null))
        .rejects.toThrow('Пользователь не авторизован');
    });

    it('throws 403 when user is FINANCE_MANAGER', async () => {
      await expect(SalesAnalyticsService.getPlanFactAnalytics({}, financeUser))
        .rejects.toThrow('Доступ к аналитике продаж запрещен для вашей роли');
      await expect(SalesAnalyticsService.getSalesFunnelAnalytics({}, financeUser))
        .rejects.toThrow('Доступ к аналитике продаж запрещен для вашей роли');
      await expect(SalesAnalyticsService.getEnhancedManagerPerformance({}, financeUser))
        .rejects.toThrow('Доступ к аналитике продаж запрещен для вашей роли');
      await expect(SalesAnalyticsService.getApartmentDemandAnalytics({}, financeUser))
        .rejects.toThrow('Доступ к аналитике продаж запрещен для вашей роли');
    });

    it('restricts SALES_MANAGER strictly to own manager scope in Plan-Fact', async () => {
      // Sales user requests all or tries to pass managerId=4
      const result = await SalesAnalyticsService.getPlanFactAnalytics({ managerId: 4 }, salesUser1);
      expect(result.filters.managerId).toBe(salesUser1.id);
    });

    it('restricts SALES_MANAGER strictly to own manager in Enhanced Manager Performance', async () => {
      const result = await SalesAnalyticsService.getEnhancedManagerPerformance({}, salesUser1);
      expect(result.isRestrictedToSelf).toBe(true);
      expect(result.managers).toHaveLength(1);
      expect(result.managers[0].managerId).toBe(salesUser1.id);
    });
  });

  describe('Этап 2: План и факт продаж (Multi-month & Level Isolation)', () => {
    it('strictly avoids summing DEPARTMENT, PROJECT, and BUILDING tiers together', async () => {
      const result = await SalesAnalyticsService.getPlanFactAnalytics({ periods: ['2026-11'] }, adminUser);
      const nov = result.monthlyComparison[0];

      // In mockPlans, there are 3 rows of 10 deals each (DEPARTMENT, PROJECT, BUILDING).
      // They represent the SAME target and must NOT be summed to 30!
      expect(nov.target.dealsCount).toBe(10);
      expect(nov.target.volumeUsd).toBe(350000);
      expect(result.summary.totalTargetDeals).toBe(10);
      expect(result.summary.totalTargetVolumeUsd).toBe(350000);
    });

    it('accurately counts actual sales strictly from SIGNED contracts and isolates RESERVED', async () => {
      const result = await SalesAnalyticsService.getPlanFactAnalytics({ periods: ['2026-10'] }, adminUser);
      const oct = result.monthlyComparison[0];

      // 10 SIGNED deals ($34,000 each = $340,000)
      expect(oct.actual.signedDealsCount).toBe(10);
      expect(oct.actual.signedVolumeUsd).toBe(340000);

      // 5 RESERVED deals ($40,000 each = $200,000) must be in pipelineSupplementary, NOT in actual!
      expect(oct.pipelineSupplementary.reservedCount).toBe(5);
      expect(oct.pipelineSupplementary.reservedVolumeUsd).toBe(200000);

      // 6 CANCELLED deals
      expect(oct.pipelineSupplementary.cancelledCount).toBe(6);
    });

    it('calculates multi-month trend and gap deviations accurately across Aug, Sep, Oct', async () => {
      const result = await SalesAnalyticsService.getPlanFactAnalytics({
        periods: ['2026-08', '2026-09', '2026-10']
      }, adminUser);

      expect(result.monthlyComparison).toHaveLength(3);
      expect(result.monthlyComparison[0].period).toBe('2026-08');
      expect(result.monthlyComparison[0].actual.signedDealsCount).toBe(12);
      expect(result.monthlyComparison[1].period).toBe('2026-09');
      expect(result.monthlyComparison[1].actual.signedDealsCount).toBe(14);
      expect(result.monthlyComparison[2].period).toBe('2026-10');
      expect(result.monthlyComparison[2].actual.signedDealsCount).toBe(10);

      // Total actual deals: 12 + 14 + 10 = 36
      expect(result.summary.totalActualDeals).toBe(36);
    });
  });

  describe('Этап 3: Сквозная воронка продаж полного цикла', () => {
    it('constructs 5-stage funnel with zero double-counting', async () => {
      const result = await SalesAnalyticsService.getSalesFunnelAnalytics({}, adminUser);

      expect(result.stages).toHaveLength(5);
      expect(result.stages.map(s => s.id)).toEqual([
        'NEW', 'IN_PROGRESS', 'NEGOTIATION', 'RESERVED', 'SIGNED'
      ]);

      // Check stage counts match our mock records
      expect(result.stages.find(s => s.id === 'NEW').count).toBe(1);
      expect(result.stages.find(s => s.id === 'IN_PROGRESS').count).toBe(1);
      expect(result.stages.find(s => s.id === 'NEGOTIATION').count).toBe(1);
      expect(result.stages.find(s => s.id === 'RESERVED').count).toBe(5);
      expect(result.stages.find(s => s.id === 'SIGNED').count).toBe(36);
    });

    it('calculates transition cycle averages and lost reasons breakdown', async () => {
      const result = await SalesAnalyticsService.getSalesFunnelAnalytics({}, adminUser);

      expect(result.transitionCycleAverages).toHaveProperty('leadToReservationAvgDays');
      expect(result.transitionCycleAverages.leadToReservationAvgDays).toBeNull();
      expect(result.transitionCycleAverages.reservationToSigningAvgDays).toBeNull();
      expect(result.transitionCycleAverages.metrics.leadToReservation.isAvailable).toBe(false);
      expect(result.transitionCycleAverages.metrics.reservationToSigning.isAvailable).toBe(false);
      expect(result.transitionCycleAverages.metrics.fullCycleLeadToSigned.isAvailable).toBe(true);

      expect(result.lostReasons).toHaveLength(2);
      expect(result.lostReasons[0].code).toBe('PRICE');
      expect(result.lostReasons[0].label).toBe(LOST_REASON_LABELS.PRICE);
      expect(result.lostReasons[1].code).toBe('CHOSE_COMPETITOR');
    });
  });

  describe('Этап 4: Эффективность менеджеров', () => {
    it('computes processed/unprocessed leads, calls/meetings, and overdue tasks', async () => {
      const result = await SalesAnalyticsService.getEnhancedManagerPerformance({}, adminUser);

      expect(result.managers.length).toBeGreaterThanOrEqual(2);
      const mgr3 = result.managers.find(m => m.managerId === 3);
      expect(mgr3).toBeDefined();

      // Lead attribution
      expect(mgr3.assignedLeadsCount).toBe(5);
      // Leads 2, 3, 4, 10 had notes/tasks/advancement => processed
      expect(mgr3.processedLeadsCount).toBe(4);
      expect(mgr3.unprocessedLeadsCount).toBe(1);

      // Tasks: 1 completed CALL, 1 completed MEETING, 1 overdue
      expect(mgr3.completedCalls).toBe(1);
      expect(mgr3.completedMeetings).toBe(1);
      expect(mgr3.overdueTasksCount).toBe(1);

      // Deals: 36 total signed, mgr3 has signed deals
      expect(mgr3.signedDealsCount).toBeGreaterThan(0);
      expect(mgr3.salesVolumeUsd).toBeGreaterThan(0);
    });

    it('filters deals and leads by period, project, and building accurately', async () => {
      const result = await SalesAnalyticsService.getEnhancedManagerPerformance({
        period: '2026-10',
        projectId: 3,
        buildingId: 3,
        managerId: 3
      }, adminUser);

      expect(result.managers).toHaveLength(1);
      const mgr3 = result.managers[0];
      expect(mgr3.managerId).toBe(3);
      // In 2026-10, deals are filtered by signed_at/deal_date starting with 2026-10
      expect(mgr3.reservedDealsCount).toBe(5);
    });
  });

  describe('Этап 5: Аналитика спроса на квартиры (lead_interested_units)', () => {
    it('separates unique buyers count from total interests count', async () => {
      const result = await SalesAnalyticsService.getApartmentDemandAnalytics({}, adminUser);

      expect(result.state).toBe('SUCCESS_WITH_DATA');
      expect(result.isAvailable).toBe(true);
      // We have 3 rows in mockInterests: 2 for Lead 10, 1 for Lead 11
      expect(result.summary.totalInterestsCount).toBe(3);
      expect(result.summary.uniqueBuyersCount).toBe(2);
    });

    it('returns DATA_UNAVAILABLE state with clean safe message when database query fails', async () => {
      // Mock database error for lead_interested_units
      mockDB.from.mockImplementationOnce((table) => {
        if (table === 'lead_interested_units') {
          return {
            select: vi.fn(() => ({
              then(resolve) {
                resolve({ data: null, error: { code: '42501', message: 'permission denied for table lead_interested_units' } });
              }
            }))
          };
        }
      });

      const result = await SalesAnalyticsService.getApartmentDemandAnalytics({}, adminUser);

      expect(result.state).toBe('DATA_UNAVAILABLE');
      expect(result.isAvailable).toBe(false);
      expect(result.message).toBe('Данные аналитики спроса временно недоступны');
      expect(result.summary.totalInterestsCount).toBe(0);
      expect(result.summary.uniqueBuyersCount).toBe(0);
      expect(result.topDemandedUnits).toHaveLength(0);
      expect(result.demandByRooms).toHaveLength(0);
      // Asserts no internal error codes or postgres details are leaked to client response
      expect(JSON.stringify(result)).not.toContain('42501');
      expect(JSON.stringify(result)).not.toContain('permission denied');
    });

    it('returns SUCCESS_EMPTY state when query succeeds but no interest records exist', async () => {
      mockDB.from.mockImplementationOnce((table) => {
        if (table === 'lead_interested_units') {
          return {
            select: vi.fn(() => ({
              then(resolve) {
                resolve({ data: [], error: null });
              }
            }))
          };
        }
      });

      const result = await SalesAnalyticsService.getApartmentDemandAnalytics({}, adminUser);

      expect(result.state).toBe('SUCCESS_EMPTY');
      expect(result.isAvailable).toBe(true);
      expect(result.message).toBeNull();
      expect(result.summary.totalInterestsCount).toBe(0);
      expect(result.summary.uniqueBuyersCount).toBe(0);
      expect(result.topDemandedUnits).toHaveLength(0);
    });

    it('ranks most in-demand units accurately', async () => {
      const result = await SalesAnalyticsService.getApartmentDemandAnalytics({}, adminUser);

      // Unit 90 has 2 interests (Lead 10 and Lead 11)
      // Unit 91 has 1 interest (Lead 10)
      expect(result.topDemandedUnits).toHaveLength(2);
      expect(result.topDemandedUnits[0].unitNumber).toBe('18');
      expect(result.topDemandedUnits[0].interestsCount).toBe(2);
      expect(result.topDemandedUnits[0].uniqueBuyersCount).toBe(2);
      expect(result.topDemandedUnits[0].priorities.HIGH).toBe(2);

      expect(result.topDemandedUnits[1].unitNumber).toBe('25');
      expect(result.topDemandedUnits[1].interestsCount).toBe(1);
      expect(result.topDemandedUnits[1].uniqueBuyersCount).toBe(1);
    });

    it('aggregates demand by room count, floors, area bands, and price bands', async () => {
      const result = await SalesAnalyticsService.getApartmentDemandAnalytics({}, adminUser);

      // By rooms: 2-room has 2 interests, 3-room has 1 interest
      const twoRooms = result.demandByRooms.find(r => r.rooms === '2-комн.');
      expect(twoRooms.interestsCount).toBe(2);
      const threeRooms = result.demandByRooms.find(r => r.rooms === '3-комн.');
      expect(threeRooms.interestsCount).toBe(1);

      // By floors: Floor 3 has 2 interests, Floor 4 has 1 interest
      expect(result.demandByFloors.find(f => f.floorNumber === 3).interestsCount).toBe(2);
      expect(result.demandByFloors.find(f => f.floorNumber === 4).interestsCount).toBe(1);

      // By area & price bands exist
      expect(result.demandByArea).toHaveLength(4);
      expect(result.demandByPrice).toHaveLength(4);
    });
  });

  describe('Этап 6: Экспорт в Excel / CSV', () => {
    it('generates UTF-8 BOM CSV with semicolon delimiters for plan_fact, managers, and demand', async () => {
      const planFactCsv = await SalesAnalyticsService.exportSalesAnalyticsCsv('plan_fact', {}, adminUser);
      expect(planFactCsv.startsWith('\uFEFF')).toBe(true);
      expect(planFactCsv).toContain('Период;План (кв);Факт (кв)');
      expect(planFactCsv).toContain('ИТОГО');

      const managersCsv = await SalesAnalyticsService.exportSalesAnalyticsCsv('managers', {}, adminUser);
      expect(managersCsv.startsWith('\uFEFF')).toBe(true);
      expect(managersCsv).toContain('Менеджер;Роль;Лиды (всего)');

      const demandCsv = await SalesAnalyticsService.exportSalesAnalyticsCsv('demand', {}, adminUser);
      expect(demandCsv.startsWith('\uFEFF')).toBe(true);
      expect(demandCsv).toContain('Квартира;Комнат;Площадь (м²);Этаж');
    });
  });
});
