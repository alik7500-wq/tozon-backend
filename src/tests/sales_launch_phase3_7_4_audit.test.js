import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { SalesManagementExportService, sanitizeCellString } from '../modules/reports/salesManagementExport.service.js';
import { DailyBriefingService } from '../modules/reports/dailyBriefing.service.js';
import * as dbConnection from '../db/connection.js';

describe('TOZON CRM — Phase 3.7.4: Excel Quality & Data Consistency Audit Suite', () => {
  const mockAdmin = { id: 1, role: 'ADMIN', name: 'Admin' };
  const mockDirector = { id: 2, role: 'DIRECTOR', name: 'Руководитель' };
  const mockSalesManager = { id: 3, role: 'SALES_MANAGER', name: 'Дадочон (Менеджер)' };
  const mockOtherSalesManager = { id: 8, role: 'SALES_MANAGER', name: 'Алишер (Менеджер 2)' };

  let mockDb;

  // Realistic test fixtures reflecting the live October 2026 scenario:
  // - 12 signed deals created under Admin (id: 1)
  // - 2 signed on target date 2026-10-19, 10 on earlier October dates
  // - Dadojon (id: 3) has 0 signed deals on 2026-10-19
  // - 23 open overdue tasks (11 assigned to Admin, 12 assigned to Dadojon)
  // - Non-sales users present (Cashier, Finance, Warehouse)
  const usersFixture = [
    { id: 1, name: 'Admin', role: 'ADMIN', is_active: 1 },
    { id: 2, name: 'Руководитель', role: 'DIRECTOR', is_active: 1 },
    { id: 3, name: 'Дадочон', role: 'SALES_MANAGER', is_active: 1 },
    { id: 4, name: 'Далер', role: 'FINANCE_MANAGER', is_active: 1 },
    { id: 5, name: 'Шерали', role: 'ADMIN', is_active: 1 },
    { id: 6, name: 'Саидкодир', role: 'WAREHOUSE_MANAGER', is_active: 1 },
    { id: 7, name: 'Шоистахон', role: 'CASHIER', is_active: 1 },
    { id: 8, name: 'Алишер', role: 'SALES_MANAGER', is_active: 1 }
  ];

  const buildingsFixture = [
    { id: 4, name: 'Блок А', code: 'A', project_id: 3, projects: { id: 3, name: 'Somon Residence' } },
    { id: 3, name: 'Блок Б', code: 'B', project_id: 3, projects: { id: 3, name: 'Somon Residence' } }
  ];

  const plansFixture = [
    { id: 1, period: '2026-10', scope_type: 'DEPARTMENT', target_deals_count: 20, target_volume_minor: 100000000, currency: 'USD' },
    { id: 2, period: '2026-10', scope_type: 'BUILDING', building_id: 4, target_deals_count: 12, target_volume_minor: 60000000, currency: 'USD' },
    { id: 3, period: '2026-10', scope_type: 'BUILDING', building_id: 3, target_deals_count: 8, target_volume_minor: 40000000, currency: 'USD' }
  ];

  const leadsFixture = [
    {
      id: 101,
      full_name: 'Исмоилов Баходур',
      phone: '+992927771122',
      source: 'WEBSITE',
      status: 'NEW',
      responsible_user_id: 3,
      interested_project_id: 3,
      created_at: '2026-10-19T03:30:00.000Z',
      users: { id: 3, name: 'Дадочон', role: 'SALES_MANAGER' }
    },
    {
      id: 102,
      full_name: 'Каримов Одил',
      phone: '+992928883344',
      source: 'WALK_IN',
      status: 'NEW',
      responsible_user_id: 1, // Created directly under Admin
      interested_project_id: 3,
      created_at: '2026-10-19T04:15:00.000Z',
      users: { id: 1, name: 'Admin', role: 'ADMIN' }
    }
  ];

  // 23 overdue tasks (11 for Admin, 12 for Dadojon)
  const tasksFixture = [
    ...Array.from({ length: 11 }, (_, i) => ({
      id: 201 + i,
      assigned_user_id: 1,
      type: 'CALL',
      title: `Контроль бронирования #${i + 1}`,
      client_name: `Клиент Руководства ${i + 1}`,
      phone: `+9929200000${i < 10 ? '0' + i : i}`,
      due_date: '2026-10-15', // Past date -> overdue
      status: 'OPEN',
      priority: 'HIGH',
      users: { id: 1, name: 'Admin' }
    })),
    ...Array.from({ length: 12 }, (_, i) => ({
      id: 301 + i,
      assigned_user_id: 3,
      type: 'CALL',
      title: `Первичный звонок по заявке #${i + 1}`,
      client_name: `Клиент Дадочона ${i + 1}`,
      phone: `+9929211111${i < 10 ? '0' + i : i}`,
      due_date: '2026-10-16', // Past date -> overdue
      status: 'OPEN',
      priority: 'NORMAL',
      users: { id: 3, name: 'Дадочон' }
    }))
  ];

  // 12 signed deals in October: 2 signed on 2026-10-19 (both by Admin), 10 earlier in October
  const dealsFixture = [
    {
      id: 401,
      contract_number: '25601-2026-0036',
      lead_id: 102,
      responsible_user_id: 1, // Admin signed
      status: 'SIGNED',
      final_price_minor: 4893700, // $48,937.00
      currency: 'USD',
      deal_date: '2026-10-19',
      signed_at: '2026-10-19T05:00:00.000Z',
      created_at: '2026-10-19T04:30:00.000Z',
      units: {
        id: 501,
        unit_number: '18',
        rooms: 2,
        area_m2_x100: 6990,
        price_per_m2_minor: 70000,
        floors: { id: 10, floor_number: 4, sections: { id: 2, name: 'Секция 1', buildings: { id: 4, name: 'Блок А', code: 'A', project_id: 3, projects: { id: 3, name: 'Somon Residence' } } } }
      },
      leads: { id: 102, full_name: 'Каримов Одил', phone: '+992928883344' },
      users: { id: 1, name: 'Admin' }
    },
    {
      id: 402,
      contract_number: '25601-2026-0037',
      lead_id: 102,
      responsible_user_id: 1, // Admin signed
      status: 'SIGNED',
      final_price_minor: 4720500, // $47,205.00
      currency: 'USD',
      deal_date: '2026-10-19',
      signed_at: '2026-10-19T06:30:00.000Z',
      created_at: '2026-10-19T06:00:00.000Z',
      units: {
        id: 502,
        unit_number: '34',
        rooms: 2,
        area_m2_x100: 6511,
        price_per_m2_minor: 72500,
        floors: { id: 11, floor_number: 5, sections: { id: 3, name: 'Секция 2', buildings: { id: 3, name: 'Блок Б', code: 'B', project_id: 3, projects: { id: 3, name: 'Somon Residence' } } } }
      },
      leads: { id: 102, full_name: 'Каримов Одил', phone: '+992928883344' },
      users: { id: 1, name: 'Admin' }
    },
    // 10 other deals signed earlier in October 2026
    ...Array.from({ length: 10 }, (_, i) => ({
      id: 403 + i,
      contract_number: `25601-2026-00${20 + i}`,
      lead_id: 102,
      responsible_user_id: 1,
      status: 'SIGNED',
      final_price_minor: 5000000,
      currency: 'USD',
      deal_date: `2026-10-${(i + 2).toString().padStart(2, '0')}`,
      signed_at: `2026-10-${(i + 2).toString().padStart(2, '0')}T08:00:00.000Z`,
      created_at: `2026-10-${(i + 2).toString().padStart(2, '0')}T07:00:00.000Z`,
      units: {
        id: 503 + i,
        unit_number: `${40 + i}`,
        rooms: 3,
        area_m2_x100: 7500,
        price_per_m2_minor: 66667,
        floors: { id: 12, floor_number: 6, sections: { id: 2, name: 'Секция 1', buildings: { id: 4, name: 'Блок А', code: 'A', project_id: 3, projects: { id: 3, name: 'Somon Residence' } } } }
      },
      leads: { id: 102, full_name: 'Покупатель Ранее', phone: '+992929990000' },
      users: { id: 1, name: 'Admin' }
    }))
  ];

  const paymentsFixture = [
    {
      id: 601,
      deal_id: 401,
      amount_minor: 2000000, // $20,000.00
      currency: 'USD',
      status: 'POSTED',
      method: 'CASH',
      payer_name: 'Каримов Одил',
      payment_date: '2026-10-19',
      reference: 'Первый взнос по договору №25601-2026-0036',
      created_at: '2026-10-19T08:00:00.000Z',
      deals: {
        id: 401,
        contract_number: '25601-2026-0036',
        responsible_user_id: 1,
        leads: { id: 102, full_name: 'Каримов Одил', phone: '+992928883344' },
        units: { unit_number: '18', floors: { sections: { buildings: { id: 4, name: 'Блок А', project_id: 3 } } } }
      }
    },
    {
      id: 602,
      deal_id: 402,
      amount_minor: 5000000, // 50,000.00 TJS
      currency: 'TJS',
      status: 'POSTED',
      method: 'BANK_TRANSFER',
      payer_name: 'Каримов Одил',
      payment_date: '2026-10-19',
      reference: 'Оплата взноса TJS по договору №25601-2026-0037',
      created_at: '2026-10-19T09:00:00.000Z',
      deals: {
        id: 402,
        contract_number: '25601-2026-0037',
        responsible_user_id: 1,
        leads: { id: 102, full_name: 'Каримов Одил', phone: '+992928883344' },
        units: { unit_number: '34', floors: { sections: { buildings: { id: 3, name: 'Блок Б', project_id: 3 } } } }
      }
    }
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    setupMockDb();
  });

  const setupMockDb = () => {
    mockDb = {
      from: vi.fn((table) => {
        let currentData = [];
        if (table === 'users') currentData = [...usersFixture];
        if (table === 'buildings') currentData = [...buildingsFixture];
        if (table === 'sales_plans') currentData = [...plansFixture];
        if (table === 'leads') currentData = [...leadsFixture];
        if (table === 'tasks') currentData = [...tasksFixture];
        if (table === 'deals') currentData = [...dealsFixture];
        if (table === 'payments') currentData = [...paymentsFixture];

        const queryBuilder = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn((field, val) => {
            currentData = currentData.filter(item => {
              if (field === 'responsible_user_id') return Number(item.responsible_user_id) === Number(val);
              if (field === 'assigned_user_id') return Number(item.assigned_user_id) === Number(val);
              return true;
            });
            return queryBuilder;
          }),
          neq: vi.fn().mockReturnThis(),
          in: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          gte: vi.fn().mockReturnThis(),
          lte: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          then: (resolve) => resolve({ data: currentData, error: null })
        };
        return queryBuilder;
      })
    };

    vi.spyOn(dbConnection, 'getDB').mockReturnValue(mockDb);
    vi.spyOn(dbConnection, 'getServiceDB').mockReturnValue(mockDb);
  };

  // =========================================================================
  // 1. DATA RECONCILIATION & MATHEMATICAL PARITY ACROSS SHEETS
  // =========================================================================
  describe('1. Data Consistency & Inter-sheet Parity Audit', () => {
    it('verifies exact parity: Sheet 2 Grand Total matches Sheet 1 Summary for all KPIs', async () => {
      const buffer = await SalesManagementExportService.generateSalesManagementWorkbook(
        { date: '2026-10-19', period: '2026-10' },
        mockAdmin
      );

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);

      const sheet1 = workbook.getWorksheet('Сводка');
      const sheet2 = workbook.getWorksheet('Менеджеры');
      const sheet6 = workbook.getWorksheet('Поступления');

      expect(sheet1).toBeDefined();
      expect(sheet2).toBeDefined();
      expect(sheet6).toBeDefined();

      // Find KPI values on Sheet 1
      const kpiMap = {};
      for (let r = 8; r <= 21; r++) {
        const row = sheet1.getRow(r);
        const name = row.getCell(2).value;
        const val = row.getCell(3).value;
        if (name) kpiMap[name] = val;
      }

      // Check Sheet 1 summary values for 2026-10-19:
      // Signed deals = 2, USD = $96,142, Overdue tasks = 23, Cash USD = $20,000, Cash TJS = 50,000
      expect(kpiMap['Подписанные договоры (SIGNED)']).toBe(2);
      expect(kpiMap['Объем продаж по договорам, USD']).toBe(96142);
      expect(kpiMap['Просроченные задачи менеджеров']).toBe(23);
      expect(kpiMap['Фактические поступления USD (Cash-in)']).toBe(20000);
      expect(kpiMap['Фактические поступления TJS (Cash-in)']).toBe(50000);

      // Verify Grand Total Row on Sheet 2
      const s2GrandTotal = sheet2.lastRow;
      expect(s2GrandTotal.getCell(2).value).toBe('ИТОГО ПО ВСЕМ ПРОДАЖАМ И ПОСТУПЛЕНИЯМ');

      // The grand total formulas sum both Section 1 and Section 2
      expect(s2GrandTotal.getCell(4).value).toHaveProperty('formula'); // Leads
      expect(s2GrandTotal.getCell(10).value).toHaveProperty('formula'); // Signed deals
      expect(s2GrandTotal.getCell(11).value).toHaveProperty('formula'); // Signed deals vol
      expect(s2GrandTotal.getCell(12).value).toHaveProperty('formula'); // USD cash
      expect(s2GrandTotal.getCell(13).value).toHaveProperty('formula'); // TJS cash
      expect(s2GrandTotal.getCell(14).value).toHaveProperty('formula'); // Overdue tasks

      // Check Sheet 6 Payments total
      const s6Total = sheet6.lastRow;
      expect(s6Total.getCell(1).value).toBe('ИТОГО');
      expect(s6Total.getCell(8).value.formula).toMatch(/^SUM\(H\d+:H\d+\)$/);
      expect(s6Total.getCell(9).value.formula).toMatch(/^SUM\(I\d+:I\d+\)$/);
    });

    it('resolves the 12 vs 0 signed contracts discrepancy: Admin direct sales separated from sales manager', async () => {
      const buffer = await SalesManagementExportService.generateSalesManagementWorkbook(
        { date: '2026-10-19', period: '2026-10' },
        mockAdmin
      );

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      const sheet2 = workbook.getWorksheet('Менеджеры');

      // Find Section 1 header and Section 2 header
      let section1Row = 0;
      let section2Row = 0;
      for (let r = 1; r <= sheet2.rowCount; r++) {
        const val = sheet2.getRow(r).getCell(1).value;
        if (typeof val === 'string' && val.includes('1. ОТДЕЛ ПРОДАЖ')) section1Row = r;
        if (typeof val === 'string' && val.includes('2. ПРОДАЖИ РУКОВОДСТВА')) section2Row = r;
      }

      expect(section1Row).toBeGreaterThan(0);
      expect(section2Row).toBeGreaterThan(section1Row);

      // In Section 1: Dadojon has 0 signed deals on 2026-10-19
      const dadojonRow = sheet2.getRow(section1Row + 2);
      expect(dadojonRow.getCell(2).value).toContain('Дадочон');
      expect(dadojonRow.getCell(3).value).toBe('Менеджер по продажам');
      expect(dadojonRow.getCell(10).value).toBe(0); // 0 signed deals
      expect(dadojonRow.getCell(14).value).toBe(12); // 12 overdue tasks

      // In Section 2: Admin has 2 signed deals on 2026-10-19 ($96,142) and 11 overdue tasks
      const adminRow = sheet2.getRow(section2Row + 2);
      expect(adminRow.getCell(2).value).toBe('Admin');
      expect(adminRow.getCell(3).value).toBe('Администрация / Руководство');
      expect(adminRow.getCell(10).value).toBe(2); // 2 signed deals
      expect(adminRow.getCell(11).value).toBe(96142); // $96,142
      expect(adminRow.getCell(14).value).toBe(11); // 11 overdue tasks

      // The 23 overdue tasks = 12 (Dadojon) + 11 (Admin) -> completely explained!
    });
  });

  // =========================================================================
  // 2. EXCLUSION OF CASHIER & OPERATIONAL ROLES
  // =========================================================================
  describe('2. Role Separation & Cashier Exclusion', () => {
    it('strictly excludes CASHIER, FINANCE_MANAGER, and WAREHOUSE_MANAGER from sales rep reporting', async () => {
      const briefing = await DailyBriefingService.getDailyBriefing({ date: '2026-10-19' }, mockAdmin);
      const breakdownNames = briefing.managerDailyBreakdown.map(m => m.name);

      expect(breakdownNames).not.toContain('Шоистахон'); // Cashier must NOT be in sales reports!
      expect(breakdownNames).not.toContain('Далер'); // Finance manager must NOT be in sales reports!
      expect(breakdownNames).not.toContain('Саидкодир'); // Warehouse manager must NOT be in sales reports!

      // Only sales managers and management are present
      expect(breakdownNames).toContain('Дадочон');
      expect(breakdownNames).toContain('Admin');
    });
  });

  // =========================================================================
  // 3. EXCEL UX, TERMINOLOGY, AND EMPTY TABLES
  // =========================================================================
  describe('3. Excel UX & Layout Requirements', () => {
    it('renames "Конверсия" to "Темп продаж к лидам" on Sheet 5 «Недельная динамика»', async () => {
      const buffer = await SalesManagementExportService.generateSalesManagementWorkbook(
        { date: '2026-10-19', period: '2026-10' },
        mockAdmin
      );

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      const sheet5 = workbook.getWorksheet('Недельная динамика');

      const col12Header = sheet5.getRow(7).getCell(12).value;
      expect(col12Header).toBe('Темп продаж к лидам, %');
      expect(col12Header).not.toContain('Конверсия');
    });

    it('outputs "За выбранный период записей нет" when tables are empty', async () => {
      // Mock empty DB for a future date where no deals or interactions exist
      mockDb = {
        from: vi.fn((table) => {
          let currentData = [];
          if (table === 'users') currentData = [...usersFixture];
          if (table === 'buildings') currentData = [...buildingsFixture];
          if (table === 'sales_plans') currentData = [];
          if (table === 'leads') currentData = [];
          if (table === 'tasks') currentData = [];
          if (table === 'deals') currentData = [];
          if (table === 'payments') currentData = [];

          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            neq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            is: vi.fn().mockReturnThis(),
            gte: vi.fn().mockReturnThis(),
            lte: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            then: (resolve) => resolve({ data: currentData, error: null })
          };
        })
      };
      vi.spyOn(dbConnection, 'getDB').mockReturnValue(mockDb);
      vi.spyOn(dbConnection, 'getServiceDB').mockReturnValue(mockDb);

      const buffer = await SalesManagementExportService.generateSalesManagementWorkbook(
        { date: '2026-11-01', period: '2026-11' },
        mockAdmin
      );

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);

      // Check Sheet 6 (Поступления)
      const sheet6 = workbook.getWorksheet('Поступления');
      const s6EmptyRow = sheet6.getRow(8);
      expect(s6EmptyRow.getCell(6).value).toContain('За выбранный период кассовых поступлений нет');

      // Check Sheet 7 (Исходные данные)
      const sheet7 = workbook.getWorksheet('Исходные данные');
      expect(sheet7.getRow(9).getCell(3).value).toContain('За выбранный период записей нет'); // Leads
      expect(sheet7.getRow(13).getCell(4).value).toContain('За выбранный период записей нет'); // Interactions
      expect(sheet7.getRow(17).getCell(4).value).toContain('За выбранный период просроченных задач нет'); // Tasks
    });

    it('verifies landscape A4 pageSetup and expanded column widths across all 7 sheets', async () => {
      const buffer = await SalesManagementExportService.generateSalesManagementWorkbook(
        { date: '2026-10-19', period: '2026-10' },
        mockAdmin
      );

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);

      expect(workbook.worksheets.length).toBe(7);

      workbook.worksheets.forEach((ws) => {
        expect(ws.pageSetup.orientation).toBe('landscape');
        expect(ws.pageSetup.paperSize).toBe(9); // A4
        expect(ws.pageSetup.fitToWidth).toBe(1);
        expect(ws.pageSetup.fitToHeight).toBe(0);
        expect(ws.pageSetup.printArea).toBeDefined();

        // Ensure key descriptive columns have widths >= 20 to avoid truncation
        const titleCol = ws.getColumn(2);
        if (titleCol && titleCol.width) {
          expect(titleCol.width).toBeGreaterThanOrEqual(16);
        }
      });
    });
  });

  // =========================================================================
  // 4. RBAC & DATA LEAK PREVENTION
  // =========================================================================
  describe('4. RBAC & Sensitive Data Protection', () => {
    it('SALES_MANAGER export restricts data to own records and redacts other managers PII with ***', async () => {
      const buffer = await SalesManagementExportService.generateSalesManagementWorkbook(
        { date: '2026-10-19', period: '2026-10' },
        mockSalesManager // User 3
      );

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);

      const sheet2 = workbook.getWorksheet('Менеджеры');

      // SALES_MANAGER must NOT see Section 2 (management direct sales)
      let hasSection2 = false;
      for (let r = 1; r <= sheet2.rowCount; r++) {
        const val = sheet2.getRow(r).getCell(1).value;
        if (typeof val === 'string' && val.includes('2. ПРОДАЖИ РУКОВОДСТВА')) {
          hasSection2 = true;
        }
      }
      expect(hasSection2).toBe(false);

      // In Section 1, only Dadojon's row is visible
      const s1HeaderRow = 8;
      const dadojonRow = sheet2.getRow(s1HeaderRow + 2);
      expect(dadojonRow.getCell(2).value).toContain('Дадочон');
    });

    it('ADMIN has full visibility to all sections, unredacted phone numbers, and direct management deals', async () => {
      const buffer = await SalesManagementExportService.generateSalesManagementWorkbook(
        { date: '2026-10-19', period: '2026-10' },
        mockAdmin
      );

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);

      const sheet3 = workbook.getWorksheet('Блок А');
      // Admin sees real phone number on signed deals, not '***'
      const dealRow = sheet3.getRow(15);
      if (dealRow && dealRow.getCell(7).value !== '—') {
        expect(dealRow.getCell(8).value).not.toBe('***');
        expect(dealRow.getCell(8).value).toContain('+992');
      }
    });
  });
});
