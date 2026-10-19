import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DailyBriefingService } from '../modules/reports/dailyBriefing.service.js';
import { WeeklyDynamicsService, getCalendarWeeksList } from '../modules/reports/weeklyDynamics.service.js';
import { BlockPlanFactService } from '../modules/reports/blockPlanFact.service.js';
import * as dbConnection from '../db/connection.js';

describe('TOZON CRM — Phase 3.7.1 Sales Management Analytics Suite', () => {
  const mockAdmin = { id: 1, role: 'ADMIN', name: 'Администратор' };
  const mockDirector = { id: 2, role: 'DIRECTOR', name: 'Директор' };
  const mockSalesManager = { id: 3, role: 'SALES_MANAGER', name: 'Дадоджон Саидов' };
  const mockFinance = { id: 4, role: 'FINANCE_MANAGER', name: 'Финансист' };
  const mockWarehouse = { id: 6, role: 'WAREHOUSE_MANAGER', name: 'Завсклад' };

  let mockDb;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const setupMockDb = (customData = {}) => {
    const defaultUsers = [
      { id: 1, name: 'Администратор', role: 'ADMIN', is_active: 1 },
      { id: 2, name: 'Директор', role: 'DIRECTOR', is_active: 1 },
      { id: 3, name: 'Дадоджон Саидов', role: 'SALES_MANAGER', is_active: 1 },
      { id: 7, name: 'Алишер Менеджер', role: 'SALES_MANAGER', is_active: 1 }
    ];

    const defaultBuildings = [
      { id: 4, name: 'Блок А', code: 'A', project_id: 3, projects: { id: 3, name: 'Somon Residence' } },
      { id: 3, name: 'Блок Б', code: 'B', project_id: 3, projects: { id: 3, name: 'Somon Residence' } }
    ];

    const defaultPlans = [
      { id: 1, period: '2026-10', scope_type: 'DEPARTMENT', target_deals_count: 20, target_volume_minor: 100000000, currency: 'USD' },
      { id: 2, period: '2026-10', scope_type: 'BUILDING', building_id: 4, target_deals_count: 12, target_volume_minor: 60000000, currency: 'USD' },
      { id: 3, period: '2026-10', scope_type: 'BUILDING', building_id: 3, target_deals_count: 8, target_volume_minor: 40000000, currency: 'USD' }
    ];

    const defaultLeads = [
      {
        id: 101,
        full_name: 'Исмоилов Б.',
        phone: '+992927771122',
        source: 'WEBSITE',
        status: 'NEW',
        responsible_user_id: 3,
        interested_project_id: 3,
        created_at: '2026-10-19T03:30:00.000Z', // 08:30 Asia/Dushanbe
        users: { id: 3, name: 'Дадоджон Саидов' }
      },
      {
        id: 102,
        full_name: 'Каримов С.',
        phone: '+992927773344',
        source: 'INSTAGRAM',
        status: 'IN_PROGRESS',
        responsible_user_id: 7,
        interested_project_id: 3,
        created_at: '2026-10-19T05:00:00.000Z', // 10:00 Asia/Dushanbe
        users: { id: 7, name: 'Алишер Менеджер' }
      },
      {
        id: 103,
        full_name: 'Вчерашний Клиент',
        phone: '+992927775566',
        source: 'PHONE',
        status: 'WON',
        responsible_user_id: 3,
        interested_project_id: 3,
        created_at: '2026-10-18T10:00:00.000Z',
        users: { id: 3, name: 'Дадоджон Саидов' }
      }
    ];

    const defaultTasks = [
      {
        id: 201,
        lead_id: 101,
        deal_id: null,
        assigned_user_id: 3,
        type: 'CALL',
        title: 'Первый контакт по лиду',
        status: 'COMPLETED',
        completed_at: '2026-10-19T04:00:00.000Z', // 09:00 Asia/Dushanbe
        client_name: 'Исмоилов Б.',
        due_date: '2026-10-19',
        priority: 'HIGH',
        users: { id: 3, name: 'Дадоджон Саидов' }
      },
      {
        id: 202,
        lead_id: 102,
        deal_id: null,
        assigned_user_id: 7,
        type: 'MEETING',
        title: 'Встреча в офисе продаж',
        status: 'COMPLETED',
        completed_at: '2026-10-19T07:00:00.000Z', // 12:00 Asia/Dushanbe
        client_name: 'Каримов С.',
        due_date: '2026-10-19',
        priority: 'NORMAL',
        users: { id: 7, name: 'Алишер Менеджер' }
      },
      {
        id: 203,
        lead_id: 101,
        deal_id: null,
        assigned_user_id: 3,
        type: 'CALL',
        title: 'Запланированный звонок (не выполнен)',
        status: 'OPEN',
        due_date: '2026-10-19',
        priority: 'NORMAL',
        users: { id: 3, name: 'Дадоджон Саидов' }
      },
      {
        id: 204,
        lead_id: 103,
        deal_id: null,
        assigned_user_id: 3,
        type: 'CALL',
        title: 'Просроченная задача',
        status: 'OPEN',
        due_date: '2026-10-15',
        priority: 'HIGH',
        users: { id: 3, name: 'Дадоджон Саидов' }
      }
    ];

    const defaultDeals = [
      {
        id: 301,
        contract_number: '101-A',
        lead_id: 101,
        unit_id: 11,
        responsible_user_id: 3,
        status: 'SIGNED',
        final_price_minor: 5000000, // $50,000
        currency: 'USD',
        deal_date: '2026-10-19',
        signed_at: '2026-10-19T06:00:00.000Z',
        leads: { id: 101, full_name: 'Исмоилов Б.', phone: '+992927771122' },
        units: {
          id: 11,
          unit_number: '12',
          rooms: 2,
          area_m2_x100: 6500, // 65.0 m²
          floors: {
            sections: {
              buildings: { id: 4, name: 'Блок А', project_id: 3, projects: { id: 3, name: 'Somon Residence' } }
            }
          }
        },
        users: { id: 3, name: 'Дадоджон Саидов' }
      },
      {
        id: 302,
        contract_number: null,
        lead_id: 102,
        unit_id: 12,
        responsible_user_id: 7,
        status: 'RESERVED',
        final_price_minor: 4200000, // $42,000
        currency: 'USD',
        deal_date: '2026-10-19',
        reservation_expires_at: '2026-10-22T18:00:00.000Z',
        created_at: '2026-10-19T05:30:00.000Z',
        leads: { id: 102, full_name: 'Каримов С.', phone: '+992927773344' },
        units: {
          id: 12,
          unit_number: '24',
          rooms: 1,
          area_m2_x100: 4500, // 45.0 m²
          floors: {
            sections: {
              buildings: { id: 3, name: 'Блок Б', project_id: 3, projects: { id: 3, name: 'Somon Residence' } }
            }
          }
        },
        users: { id: 7, name: 'Алишер Менеджер' }
      },
      {
        id: 303,
        contract_number: '99-C',
        lead_id: 103,
        unit_id: 13,
        responsible_user_id: 3,
        status: 'CANCELLED',
        final_price_minor: 6000000, // $60,000
        currency: 'USD',
        deal_date: '2026-10-19',
        cancelled_at: '2026-10-19T08:00:00.000Z',
        cancellation_reason: 'PRICE',
        leads: { id: 103, full_name: 'Вчерашний Клиент', phone: '+992927775566' },
        units: {
          id: 13,
          unit_number: '35',
          rooms: 3,
          area_m2_x100: 8500,
          floors: {
            sections: {
              buildings: { id: 4, name: 'Блок А', project_id: 3, projects: { id: 3, name: 'Somon Residence' } }
            }
          }
        },
        users: { id: 3, name: 'Дадоджон Саидов' }
      }
    ];

    const defaultPayments = [
      {
        id: 401,
        deal_id: 301,
        amount_minor: 1500000, // $15,000
        currency: 'USD',
        status: 'POSTED',
        payment_date: '2026-10-19',
        method: 'BANK_TRANSFER',
        payer_name: 'Исмоилов Б.',
        created_at: '2026-10-19T07:30:00.000Z',
        deals: {
          id: 301,
          contract_number: '101-A',
          responsible_user_id: 3,
          leads: { id: 101, full_name: 'Исмоилов Б.', phone: '+992927771122' },
          units: { unit_number: '12', floors: { sections: { buildings: { id: 4, name: 'Блок А', project_id: 3 } } } }
        }
      }
    ];

    const data = {
      users: customData.users || defaultUsers,
      buildings: customData.buildings || defaultBuildings,
      sales_plans: customData.sales_plans || defaultPlans,
      leads: customData.leads || defaultLeads,
      tasks: customData.tasks || defaultTasks,
      deals: customData.deals || defaultDeals,
      payments: customData.payments || defaultPayments
    };

    mockDb = {
      from: vi.fn((table) => {
        let rows = [...(data[table] || [])];
        const chain = {
          select: vi.fn(() => chain),
          eq: vi.fn((col, val) => {
            rows = rows.filter(r => r[col] == val);
            return chain;
          }),
          neq: vi.fn((col, val) => {
            rows = rows.filter(r => r[col] !== val);
            return chain;
          }),
          is: vi.fn((col, val) => {
            rows = rows.filter(r => val === null ? (r[col] === null || r[col] === undefined) : r[col] === val);
            return chain;
          }),
          order: vi.fn(() => chain),
          then: vi.fn((resolve) => resolve({ data: rows, error: null }))
        };
        return chain;
      })
    };

    vi.spyOn(dbConnection, 'getServiceDB').mockReturnValue(mockDb);
    vi.spyOn(dbConnection, 'getDB').mockReturnValue(mockDb);

    return mockDb;
  };

  // =========================================================================
  // 1. ЕЖЕДНЕВНАЯ СВОДКА РУКОВОДИТЕЛЯ (DAILY BRIEFING)
  // =========================================================================
  describe('1. DailyBriefingService', () => {
    beforeEach(() => {
      setupMockDb();
    });

    it('successfully computes daily summary metrics with exact drilldown correspondence', async () => {
      const res = await DailyBriefingService.getDailyBriefing({ date: '2026-10-19' }, mockAdmin);

      expect(res.date).toBe('2026-10-19');
      expect(res.timezone).toBe('Asia/Dushanbe');

      const s = res.summary;
      const d = res.drilldowns;

      // 1. New leads on 2026-10-19 (Leads 101 and 102)
      expect(s.newLeadsCount).toBe(2);
      expect(d.newLeads).toHaveLength(2);
      expect(d.newLeads.map(l => l.id)).toEqual([101, 102]);

      // 2. Completed calls and meetings
      expect(s.completedCallsCount).toBe(1);
      expect(d.completedCalls).toHaveLength(1);
      expect(d.completedCalls[0].id).toBe(201);

      expect(s.completedMeetingsCount).toBe(1);
      expect(d.completedMeetings).toHaveLength(1);
      expect(d.completedMeetings[0].id).toBe(202);

      // Rule: "Не считать запланированные звонки выполненными"
      // Task 203 is OPEN, must NOT be in completedCalls
      expect(d.completedCalls.find(c => c.id === 203)).toBeUndefined();

      // 3. New reservations (Deal 302: RESERVED)
      // Rule: "Не смешивать бронирования с подписанными договорами"
      expect(s.newReservationsCount).toBe(1);
      expect(d.newReservations).toHaveLength(1);
      expect(d.newReservations[0].id).toBe(302);
      expect(s.newReservationsVolumeMinor).toBe(4200000); // $42,000

      // 4. Signed contracts (Deal 301: SIGNED)
      // Rule: "Не включать отменённые и расторгнутые сделки в действующий факт продаж"
      expect(s.signedDealsCount).toBe(1);
      expect(d.signedDeals).toHaveLength(1);
      expect(d.signedDeals[0].id).toBe(301);
      expect(s.signedDealsVolumeMinor).toBe(5000000); // $50,000
      expect(s.signedDealsVolumeUsd).toBe(50000);
      expect(s.signedAreaM2).toBe(65.0);

      // Cancelled deals must be strictly isolated
      expect(s.cancelledDealsCount).toBe(1);
      expect(d.cancelledDeals).toHaveLength(1);
      expect(d.cancelledDeals[0].id).toBe(303);
      expect(d.signedDeals.find(deal => deal.id === 303)).toBeUndefined();

      // 5. Posted payments (Payment 401: $15,000)
      // Rule: "Не смешивать стоимость договоров с фактически полученными платежами"
      expect(s.collectedCashMinor).toBe(1500000);
      expect(s.collectedCashUsd).toBe(15000);
      expect(d.postedPayments).toHaveLength(1);
      expect(d.postedPayments[0].id).toBe(401);

      // 6. Overdue tasks (Task 204: due 2026-10-15 < 2026-10-19)
      expect(s.overdueTasksCount).toBe(1);
      expect(d.overdueTasks).toHaveLength(1);
      expect(d.overdueTasks[0].id).toBe(204);

      // 7. Exact mathematical consistency between summary counts and drilldowns
      expect(s.newLeadsCount).toBe(d.newLeads.length);
      expect(s.completedCallsCount).toBe(d.completedCalls.length);
      expect(s.completedMeetingsCount).toBe(d.completedMeetings.length);
      expect(s.newReservationsCount).toBe(d.newReservations.length);
      expect(s.signedDealsCount).toBe(d.signedDeals.length);
      expect(s.collectedCashMinor).toBe(d.postedPayments.reduce((sum, p) => sum + p.amountMinor, 0));
      expect(s.overdueTasksCount).toBe(d.overdueTasks.length);
    });

    it('enforces RBAC: Sales Manager sees only their own data in daily briefing', async () => {
      const res = await DailyBriefingService.getDailyBriefing({ date: '2026-10-19' }, mockSalesManager);

      // Manager 3 (Дадоджон) owns Lead 101, Deal 301, Task 201, Payment 401.
      // Lead 102 and Deal 302 belong to Manager 7.
      expect(res.isSupervisor).toBe(false);
      expect(res.summary.newLeadsCount).toBe(1);
      expect(res.drilldowns.newLeads[0].id).toBe(101);

      // Reservation 302 belongs to Manager 7 -> must NOT appear for Manager 3
      expect(res.summary.newReservationsCount).toBe(0);
      expect(res.drilldowns.newReservations).toHaveLength(0);

      // Signed deal 301 belongs to Manager 3
      expect(res.summary.signedDealsCount).toBe(1);
      expect(res.drilldowns.signedDeals[0].id).toBe(301);

      // Meeting 202 belongs to Manager 7 -> must NOT appear
      expect(res.summary.completedMeetingsCount).toBe(0);
      expect(res.summary.completedCallsCount).toBe(1);
    });

    it('enforces RBAC: 403 Forbidden for FINANCE_MANAGER and WAREHOUSE_MANAGER', async () => {
      await expect(DailyBriefingService.getDailyBriefing({ date: '2026-10-19' }, mockFinance))
        .rejects.toThrow('Доступ к ежедневной сводке продаж запрещен для вашей роли');

      await expect(DailyBriefingService.getDailyBriefing({ date: '2026-10-19' }, mockWarehouse))
        .rejects.toThrow('Доступ к ежедневной сводке продаж запрещен для вашей роли');
    });

    it('enforces multi-currency separation: does not blend USD and TJS into a single sum', async () => {
      // Add a TJS payment to the payments list
      const multiCurrencyPayments = [
        {
          id: 401,
          deal_id: 301,
          amount_minor: 1500000, // $15,000 USD
          currency: 'USD',
          status: 'ACTIVE',
          payment_date: '2026-10-19',
          payer_name: 'Исмоилов Б.',
          deals: { id: 301, contract_number: '101-A', responsible_user_id: 3 }
        },
        {
          id: 402,
          deal_id: 301,
          amount_minor: 2000000, // 20,000 TJS
          currency: 'TJS',
          status: 'ACTIVE',
          payment_date: '2026-10-19',
          payer_name: 'Исмоилов Б.',
          deals: { id: 301, contract_number: '101-A', responsible_user_id: 3 }
        }
      ];

      setupMockDb({ payments: multiCurrencyPayments });

      const res = await DailyBriefingService.getDailyBriefing({ date: '2026-10-19' }, mockAdmin);

      expect(res.summary.paymentsCount).toBe(2);
      expect(res.summary.collectedCashMinor).toBe(1500000); // USD primary volume
      expect(res.summary.collectedCashUsd).toBe(15000);
      expect(res.summary.collectedCashTjs).toBe(20000);
      expect(res.summary.collectedCashByCurrency.usd.minor).toBe(1500000);
      expect(res.summary.collectedCashByCurrency.tjs.minor).toBe(2000000);

      // Verify drilldown keeps individual currencies intact
      expect(res.drilldowns.postedPayments[0].currency).toBe('USD');
      expect(res.drilldowns.postedPayments[1].currency).toBe('TJS');
    });

    it('strictly excludes VOIDED payments and non-deal expenses from cash collections', async () => {
      const mixedPayments = [
        {
          id: 401,
          deal_id: 301,
          amount_minor: 1500000,
          currency: 'USD',
          status: 'ACTIVE',
          payment_date: '2026-10-19',
          deals: { id: 301, contract_number: '101-A', responsible_user_id: 3 }
        },
        {
          id: 402,
          deal_id: 301,
          amount_minor: 500000,
          currency: 'USD',
          status: 'VOIDED', // Must be ignored
          payment_date: '2026-10-19',
          deals: { id: 301, contract_number: '101-A', responsible_user_id: 3 }
        },
        {
          id: 403,
          deal_id: null, // Non-deal general expense, must be ignored
          amount_minor: 300000,
          currency: 'USD',
          status: 'ACTIVE',
          payment_date: '2026-10-19'
        }
      ];

      setupMockDb({ payments: mixedPayments });

      const res = await DailyBriefingService.getDailyBriefing({ date: '2026-10-19' }, mockAdmin);

      expect(res.summary.paymentsCount).toBe(1);
      expect(res.summary.collectedCashMinor).toBe(1500000);
      expect(res.drilldowns.postedPayments).toHaveLength(1);
      expect(res.drilldowns.postedPayments[0].id).toBe(401);
    });

    it('validates date format: rejects invalid date with 400', async () => {
      await expect(DailyBriefingService.getDailyBriefing({ date: 'invalid-date' }, mockAdmin))
        .rejects.toThrow('Неверный формат даты');
    });

    it('anti-spoofing: SALES_MANAGER cannot bypass filter by passing foreign managerId in query', async () => {
      // Sales Manager 3 attempts to pass ?managerId=7 (Alisher)
      const res = await DailyBriefingService.getDailyBriefing({ date: '2026-10-19', managerId: 7 }, mockSalesManager);

      expect(res.isSupervisor).toBe(false);
      // Lead 102 belongs to Manager 7. Since spoofing is blocked, Manager 3 must ONLY receive their own Lead 101.
      expect(res.summary.newLeadsCount).toBe(1);
      expect(res.drilldowns.newLeads[0].id).toBe(101);
      expect(res.drilldowns.newLeads.some(l => l.id === 102)).toBe(false);
      // Reservation 302 belongs to Manager 7 -> must be blocked
      expect(res.summary.newReservationsCount).toBe(0);
      expect(res.drilldowns.newReservations).toHaveLength(0);
    });

    it('server-side pagination: caps drilldowns to drilldownLimit while preserving 100% summary total precision', async () => {
      const res = await DailyBriefingService.getDailyBriefing({
        date: '2026-10-19',
        drilldownLimit: 1,
        drilldownPage: 1
      }, mockAdmin);

      // Summary totals remain 100% accurate (2 new leads on this date)
      expect(res.summary.newLeadsCount).toBe(2);

      // Drilldown payload is capped at 1 item
      expect(res.drilldowns.newLeads).toHaveLength(1);
      expect(res.drilldownMeta).toBeDefined();
      expect(res.drilldownMeta.limit).toBe(1);
      expect(res.drilldownMeta.page).toBe(1);
      expect(res.drilldownMeta.totals.newLeads).toBe(2);
      expect(res.drilldownMeta.isTruncated.newLeads).toBe(true);

      // Requesting page 2 returns the second item
      const resPage2 = await DailyBriefingService.getDailyBriefing({
        date: '2026-10-19',
        drilldownLimit: 1,
        drilldownPage: 2
      }, mockAdmin);
      expect(resPage2.drilldowns.newLeads).toHaveLength(1);
      expect(resPage2.drilldowns.newLeads[0].id).toBe(102);
      expect(resPage2.drilldownMeta.isTruncated.newLeads).toBe(false);
    });
  });

  // =========================================================================
  // 2. ЕЖЕНЕДЕЛЬНАЯ ДИНАМИКА ПРОДАЖ (WEEKLY DYNAMICS)
  // =========================================================================
  describe('2. WeeklyDynamicsService', () => {
    beforeEach(() => {
      setupMockDb();
    });

    it('generates Monday-Sunday calendar weeks list correctly', () => {
      const weeks = getCalendarWeeksList(2026, 4, '2026-10-19');
      expect(weeks).toHaveLength(4);
      weeks.forEach(w => {
        expect(w.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(w.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // Verify Monday to Sunday (6 days difference)
        const d1 = new Date(w.startDate);
        const d2 = new Date(w.endDate);
        const diffDays = Math.round((d2 - d1) / (1000 * 3600 * 24));
        expect(diffDays).toBe(6);
      });
    });

    it('aggregates leads, reservations, signed deals, and payments by week', async () => {
      const res = await WeeklyDynamicsService.getWeeklyDynamics({ weeksCount: 4 }, mockAdmin);

      expect(res.year).toBe(2026);
      expect(res.weeks).toBeInstanceOf(Array);
      expect(res.weeks.length).toBeGreaterThan(0);

      const s = res.summary;
      // All weekly counts sum up to overall summary totals
      const sumWeeklySignedDeals = res.weeks.reduce((acc, w) => acc + w.signedDealsCount, 0);
      expect(s.totalSignedDealsCount).toBe(sumWeeklySignedDeals);

      const sumWeeklyCash = res.weeks.reduce((acc, w) => acc + w.paymentsVolumeMinor, 0);
      expect(s.totalPaymentsVolumeMinor).toBe(sumWeeklyCash);

      // Verify that every week has exact drilldowns matching weekly counts
      res.weeks.forEach(w => {
        expect(w.leadsCount).toBe(w.drilldowns.leads.length);
        expect(w.reservationsCount).toBe(w.drilldowns.reservations.length);
        expect(w.signedDealsCount).toBe(w.drilldowns.signedDeals.length);
        expect(w.paymentsCount).toBe(w.drilldowns.payments.length);
        expect(w.cancelledDealsCount).toBe(w.drilldowns.cancelledDeals.length);
      });
    });

    it('enforces RBAC: 403 Forbidden for FINANCE_MANAGER', async () => {
      await expect(WeeklyDynamicsService.getWeeklyDynamics({}, mockFinance))
        .rejects.toThrow('Доступ к еженедельной динамике продаж запрещен для вашей роли');
    });

    it('anti-spoofing: SALES_MANAGER cannot bypass filter by passing foreign managerId in weekly dynamics', async () => {
      const res = await WeeklyDynamicsService.getWeeklyDynamics({ weeksCount: 4, managerId: 7 }, mockSalesManager);
      expect(res.isSupervisor).toBe(false);
      // Overall totals for Manager 3 only
      expect(res.summary.totalLeadsCount).toBe(2); // Leads 101, 103 belong to Manager 3
      expect(res.summary.totalSignedDealsCount).toBe(1); // Deal 301 belongs to Manager 3
      expect(res.summary.totalReservationsCount).toBe(0); // Reservation 302 belongs to Manager 7
    });

    it('server-side drilldown capping: respects weekDrilldownLimit while preserving weekly totals', async () => {
      const res = await WeeklyDynamicsService.getWeeklyDynamics({ weeksCount: 4, weekDrilldownLimit: 1 }, mockAdmin);
      res.weeks.forEach(w => {
        expect(w.drilldowns.leads.length).toBeLessThanOrEqual(1);
        expect(w.drilldownMeta).toBeDefined();
        expect(w.drilldownMeta.limit).toBe(1);
      });
    });
  });

  // =========================================================================
  // 3. ПЛАН-ФАКТ ПО БЛОКАМ (BLOCK PLAN-FACT)
  // =========================================================================
  describe('3. BlockPlanFactService', () => {
    beforeEach(() => {
      setupMockDb();
    });

    it('calculates plan and actual signed contracts separately for Block A and Block B', async () => {
      const res = await BlockPlanFactService.getBlockPlanFact({ period: '2026-10' }, mockAdmin);

      expect(res.period).toBe('2026-10');
      expect(res.blocks).toHaveLength(2);

      const blockA = res.blocks.find(b => b.buildingId === 4);
      const blockB = res.blocks.find(b => b.buildingId === 3);

      expect(blockA).toBeDefined();
      expect(blockB).toBeDefined();

      // Block A: Plan = 12 deals, $600,000
      expect(blockA.plan.targetDealsCount).toBe(12);
      expect(blockA.plan.targetVolumeMinor).toBe(60000000);

      // Block A: Fact signed = 1 deal (Deal 301, $50,000, 65 m²)
      expect(blockA.fact.signedDealsCount).toBe(1);
      expect(blockA.fact.signedVolumeMinor).toBe(5000000);
      expect(blockA.fact.signedVolumeUsd).toBe(50000);
      expect(blockA.fact.signedAreaM2).toBe(65.0);
      expect(blockA.fact.averagePricePerM2Usd).toBe(Math.round(50000 / 65));

      // Execution percent: 1 / 12 = 8.3%
      expect(blockA.execution.dealsPercent).toBe(8.3);
      expect(blockA.execution.dealsGap).toBe(11);

      // Pipeline (Reservations) in Block A: 0
      expect(blockA.pipelineReserved.reservedDealsCount).toBe(0);

      // Cancelled in Block A: Deal 303 ($60,000)
      expect(blockA.cancelled.cancelledDealsCount).toBe(1);
      expect(blockA.cancelled.cancelledVolumeMinor).toBe(6000000);

      // Block B: Reservation = Deal 302 ($42,000, 45 m²)
      // Rule: "Активные бронирования отдельно от продаж"
      expect(blockB.pipelineReserved.reservedDealsCount).toBe(1);
      expect(blockB.pipelineReserved.reservedVolumeMinor).toBe(4200000);
      expect(blockB.pipelineReserved.reservedAreaM2).toBe(45.0);
      expect(blockB.fact.signedDealsCount).toBe(0);

      // Overall Department totals
      expect(res.summary.fact.signedDealsCount).toBe(1);
      expect(res.summary.fact.signedVolumeMinor).toBe(5000000);
      expect(res.summary.pipelineReserved.reservedDealsCount).toBe(1);
      expect(res.summary.pipelineReserved.reservedVolumeMinor).toBe(4200000);
      expect(res.summary.cancelled.cancelledDealsCount).toBe(1);
    });

    it('enforces RBAC: Sales Manager sees only their own deals within blocks', async () => {
      const res = await BlockPlanFactService.getBlockPlanFact({ period: '2026-10' }, mockSalesManager);

      const blockB = res.blocks.find(b => b.buildingId === 3);
      // Reservation in Block B belongs to Manager 7 -> Manager 3 sees 0
      expect(blockB.pipelineReserved.reservedDealsCount).toBe(0);

      const blockA = res.blocks.find(b => b.buildingId === 4);
      // Signed deal in Block A belongs to Manager 3 -> Manager 3 sees 1
      expect(blockA.fact.signedDealsCount).toBe(1);
    });

    it('anti-spoofing: SALES_MANAGER cannot bypass filter by passing foreign managerId in block plan-fact', async () => {
      const res = await BlockPlanFactService.getBlockPlanFact({ period: '2026-10', managerId: 7 }, mockSalesManager);
      expect(res.isSupervisor).toBe(false);

      const blockB = res.blocks.find(b => b.buildingId === 3);
      // Reservation in Block B belongs to Manager 7 -> Manager 3 must still see 0 despite managerId=7 in query
      expect(blockB.pipelineReserved.reservedDealsCount).toBe(0);
    });

    it('server-side drilldown capping: respects blockDrilldownLimit while preserving block totals', async () => {
      const res = await BlockPlanFactService.getBlockPlanFact({ period: '2026-10', blockDrilldownLimit: 1 }, mockAdmin);
      res.blocks.forEach(b => {
        expect(b.drilldowns.signedDeals.length).toBeLessThanOrEqual(1);
        expect(b.drilldownMeta).toBeDefined();
        expect(b.drilldownMeta.limit).toBe(1);
      });
    });

    it('enforces RBAC: 403 Forbidden for FINANCE_MANAGER and WAREHOUSE_MANAGER', async () => {
      await expect(BlockPlanFactService.getBlockPlanFact({ period: '2026-10' }, mockFinance))
        .rejects.toThrow('Доступ к план-факту по блокам запрещен для вашей роли');

      await expect(BlockPlanFactService.getBlockPlanFact({ period: '2026-10' }, mockWarehouse))
        .rejects.toThrow('Доступ к план-факту по блокам запрещен для вашей роли');
    });

    it('validates period format: rejects invalid period with 400', async () => {
      await expect(BlockPlanFactService.getBlockPlanFact({ period: '202610' }, mockAdmin))
        .rejects.toThrow('Неверный формат периода. Ожидается формат YYYY-MM');
    });
  });
});
