import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { SalesManagementExportService, sanitizeCellString } from '../modules/reports/salesManagementExport.service.js';
import { DailyBriefingService } from '../modules/reports/dailyBriefing.service.js';
import { WeeklyDynamicsService } from '../modules/reports/weeklyDynamics.service.js';
import { BlockPlanFactService } from '../modules/reports/blockPlanFact.service.js';
import * as dbConnection from '../db/connection.js';

describe('TOZON CRM — Phase 3.7.3 Sales Management Excel Reporting Suite', () => {
  const mockAdmin = { id: 1, role: 'ADMIN', name: 'Администратор' };
  const mockDirector = { id: 2, role: 'DIRECTOR', name: 'Директор' };
  const mockSalesManager = { id: 3, role: 'SALES_MANAGER', name: 'Дадоджон Саидов' };
  const mockFinance = { id: 4, role: 'FINANCE_MANAGER', name: 'Финансист' };
  const mockWarehouse = { id: 6, role: 'WAREHOUSE_MANAGER', name: 'Завсклад' };

  let mockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    setupMockDb();
  });

  const setupMockDb = () => {
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
        created_at: '2026-10-19T03:30:00.000Z',
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
        created_at: '2026-10-19T05:00:00.000Z',
        users: { id: 7, name: 'Алишер Менеджер' }
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
        completed_at: '2026-10-19T04:00:00.000Z',
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
        completed_at: '2026-10-19T07:00:00.000Z',
        client_name: 'Каримов С.',
        due_date: '2026-10-19',
        priority: 'NORMAL',
        users: { id: 7, name: 'Алишер Менеджер' }
      },
      {
        id: 204,
        lead_id: 101,
        deal_id: null,
        assigned_user_id: 3,
        type: 'CALL',
        title: 'Просроченный звонок',
        status: 'OPEN',
        due_date: '2026-10-15',
        priority: 'HIGH',
        client_name: 'Исмоилов Б.',
        phone: '+992927771122',
        users: { id: 3, name: 'Дадоджон Саидов' }
      }
    ];

    const defaultDeals = [
      {
        id: 301,
        contract_number: '101-A',
        lead_id: 101,
        unit_id: 1,
        responsible_user_id: 3,
        status: 'SIGNED',
        payment_type: 'INSTALLMENT',
        currency: 'USD',
        final_price_minor: 5000000, // $50,000 USD
        signed_at: '2026-10-19T06:00:00.000Z',
        deal_date: '2026-10-19',
        created_at: '2026-10-15T10:00:00.000Z',
        leads: { id: 101, full_name: 'Исмоилов Б.', phone: '+992927771122' },
        units: {
          id: 1,
          unit_number: '101',
          rooms: 2,
          area_m2_x100: 6500, // 65.0 m2
          floors: { sections: { buildings: { id: 4, name: 'Блок А', code: 'A', project_id: 3, projects: { id: 3, name: 'Somon Residence' } } } }
        },
        users: { id: 3, name: 'Дадоджон Саидов' }
      },
      {
        id: 302,
        contract_number: '205-B',
        lead_id: 102,
        unit_id: 2,
        responsible_user_id: 7,
        status: 'RESERVED',
        payment_type: 'FULL_PAYMENT',
        currency: 'USD',
        final_price_minor: 4200000, // $42,000 USD
        reservation_expires_at: '2026-10-22T18:00:00.000Z',
        deal_date: '2026-10-19',
        created_at: '2026-10-19T04:30:00.000Z',
        leads: { id: 102, full_name: 'Каримов С.', phone: '+992927773344' },
        units: {
          id: 2,
          unit_number: '205',
          rooms: 1,
          area_m2_x100: 4500, // 45.0 m2
          floors: { sections: { buildings: { id: 3, name: 'Блок Б', code: 'B', project_id: 3, projects: { id: 3, name: 'Somon Residence' } } } }
        },
        users: { id: 7, name: 'Алишер Менеджер' }
      },
      {
        id: 303,
        contract_number: '304-A',
        lead_id: 103,
        unit_id: 3,
        responsible_user_id: 3,
        status: 'CANCELLED',
        currency: 'USD',
        final_price_minor: 6000000,
        cancelled_at: '2026-10-19T07:30:00.000Z',
        cancellation_reason: 'CLIENT_REFUSAL',
        deal_date: '2026-10-19',
        leads: { id: 103, full_name: 'Клиент Отказ', phone: '+992927778899' },
        units: {
          id: 3,
          unit_number: '304',
          rooms: 3,
          area_m2_x100: 8000,
          floors: { sections: { buildings: { id: 4, name: 'Блок А', code: 'A', project_id: 3, projects: { id: 3, name: 'Somon Residence' } } } }
        },
        users: { id: 3, name: 'Дадоджон Саидов' }
      }
    ];

    const defaultPayments = [
      {
        id: 401,
        deal_id: 301,
        amount_minor: 1500000, // $15,000 USD
        currency: 'USD',
        status: 'ACTIVE',
        method: 'CASH',
        payment_date: '2026-10-19',
        payer_name: 'Исмоилов Б.',
        deals: {
          id: 301,
          contract_number: '101-A',
          responsible_user_id: 3,
          leads: { id: 101, full_name: 'Исмоилов Б.', phone: '+992927771122' },
          units: { unit_number: '101', floors: { sections: { buildings: { id: 4, name: 'Блок А', project_id: 3 } } } }
        }
      },
      {
        id: 402,
        deal_id: 301,
        amount_minor: 2000000, // 20,000 TJS
        currency: 'TJS',
        status: 'ACTIVE',
        method: 'BANK',
        payment_date: '2026-10-19',
        payer_name: 'Исмоилов Б.',
        deals: {
          id: 301,
          contract_number: '101-A',
          responsible_user_id: 3,
          leads: { id: 101, full_name: 'Исмоилов Б.', phone: '+992927771122' },
          units: { unit_number: '101', floors: { sections: { buildings: { id: 4, name: 'Блок А', project_id: 3 } } } }
        }
      }
    ];

    mockDb = {
      from: vi.fn((table) => {
        let rows = [];
        if (table === 'users') rows = [...defaultUsers];
        else if (table === 'buildings') rows = [...defaultBuildings];
        else if (table === 'sales_plans') rows = [...defaultPlans];
        else if (table === 'leads') rows = [...defaultLeads];
        else if (table === 'tasks') rows = [...defaultTasks];
        else if (table === 'deals') rows = [...defaultDeals];
        else if (table === 'payments') rows = [...defaultPayments];

        const chain = {
          select: vi.fn(() => chain),
          eq: vi.fn((col, val) => {
            rows = rows.filter(r => r[col] === val);
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
  // 1. СТРУКТУРА КНИГИ EXCEL И 7 ОБЯЗАТЕЛЬНЫХ ЛИСТОВ
  // =========================================================================
  describe('1. Workbook Structure & Required Sheets', () => {
    it('successfully generates a valid XLSX buffer containing all 7 required sheets', async () => {
      const buffer = await SalesManagementExportService.generateSalesManagementWorkbook(
        { date: '2026-10-19', period: '2026-10', weeksCount: 4 },
        mockAdmin
      );

      expect(buffer).toBeDefined();
      expect(buffer.length).toBeGreaterThan(1000);

      // Parse the generated buffer back using ExcelJS
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);

      const expectedSheets = [
        'Сводка',
        'Менеджеры',
        'Блок А',
        'Блок Б',
        'Недельная динамика',
        'Поступления',
        'Исходные данные'
      ];

      expect(workbook.worksheets.map(s => s.name)).toEqual(expectedSheets);
      expect(workbook.worksheets).toHaveLength(7);
    });

    it('sets frozen panes and auto-filters on data sheets for ergonomic viewing', async () => {
      const buffer = await SalesManagementExportService.generateSalesManagementWorkbook(
        { date: '2026-10-19', period: '2026-10' },
        mockAdmin
      );

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);

      const sheet1 = workbook.getWorksheet('Сводка');
      const sheet2 = workbook.getWorksheet('Менеджеры');
      const sheet6 = workbook.getWorksheet('Поступления');

      expect(sheet1.views[0].state).toBe('frozen');
      expect(sheet2.views[0].state).toBe('frozen');
      expect(sheet6.views[0].state).toBe('frozen');

      expect(sheet1.autoFilter).toBeDefined();
      expect(sheet2.autoFilter).toBeDefined();
      expect(sheet6.autoFilter).toBeDefined();
    });
  });

  // =========================================================================
  // 2. ЧИСЛА, ДАТЫ И ФОРМУЛЫ ИТОГОВ
  // =========================================================================
  describe('2. Numeric Types, Dates & Excel Formulas', () => {
    it('saves numbers as real numbers and dates as formatted strings', async () => {
      const buffer = await SalesManagementExportService.generateSalesManagementWorkbook(
        { date: '2026-10-19', period: '2026-10' },
        mockAdmin
      );

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);

      const sheet1 = workbook.getWorksheet('Сводка');
      // Row 8 is first KPI (New leads): Col 3 must be a numeric number
      const leadsKpiCell = sheet1.getCell('C8');
      expect(typeof leadsKpiCell.value).toBe('number');
      expect(leadsKpiCell.value).toBe(2);

      // Row 13 is Signed Deals volume USD ($50,000)
      const volumeKpiCell = sheet1.getCell('C15'); // 8 + 7 = 15
      expect(typeof volumeKpiCell.value).toBe('number');
      expect(volumeKpiCell.value).toBe(50000);
    });

    it('calculates totals via dynamic Excel formulas (SUM)', async () => {
      const buffer = await SalesManagementExportService.generateSalesManagementWorkbook(
        { date: '2026-10-19', period: '2026-10' },
        mockAdmin
      );

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);

      // Sheet 2: «Менеджеры»
      const sheet2 = workbook.getWorksheet('Менеджеры');
      const lastRowSheet2 = sheet2.lastRow;
      // Cell D (New leads sum) must contain a formula (SUM or Subtotal addition)
      expect(lastRowSheet2.getCell('D').value).toHaveProperty('formula');
      expect(lastRowSheet2.getCell('D').value.formula).toMatch(/^(SUM\(D\d+:D\d+\)|D\d+\+D\d+)$/);

      // Sheet 6: «Поступления»
      const sheet6 = workbook.getWorksheet('Поступления');
      const lastRowSheet6 = sheet6.lastRow;
      expect(lastRowSheet6.getCell('H').value).toHaveProperty('formula');
      expect(lastRowSheet6.getCell('H').value.formula).toMatch(/^SUM\(H\d+:H\d+\)$/);
      expect(lastRowSheet6.getCell('I').value).toHaveProperty('formula');
      expect(lastRowSheet6.getCell('I').value.formula).toMatch(/^SUM\(I\d+:I\d+\)$/);
    });
  });

  // =========================================================================
  // 3. РАЗДЕЛЬНЫЕ ВАЛЮТЫ (USD / TJS) И ИСКЛЮЧЕНИЕ СМЕШИВАНИЯ
  // =========================================================================
  describe('3. Multi-Currency Separation (USD vs TJS)', () => {
    it('strictly separates USD and TJS in sheet «Поступления» across distinct columns', async () => {
      const buffer = await SalesManagementExportService.generateSalesManagementWorkbook(
        { date: '2026-10-19', period: '2026-10' },
        mockAdmin
      );

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);

      const sheet6 = workbook.getWorksheet('Поступления');

      // Row 8 is Payment 401 ($15,000 USD): Col H=15000, Col I=0
      const rowUsd = sheet6.getRow(8);
      expect(rowUsd.getCell(8).value).toBe(15000);
      expect(rowUsd.getCell(9).value).toBe(0);

      // Row 9 is Payment 402 (20,000 TJS): Col H=0, Col I=20000
      const rowTjs = sheet6.getRow(9);
      expect(rowTjs.getCell(8).value).toBe(0);
      expect(rowTjs.getCell(9).value).toBe(20000);
    });
  });

  // =========================================================================
  // 4. ЗАЩИТА ОТ EXCEL FORMULA INJECTION
  // =========================================================================
  describe('4. Protection against Excel Formula Injection', () => {
    it('sanitizes strings starting with =, +, -, @, \\t, \\r by prefixing with a single quote', () => {
      expect(sanitizeCellString('=SUM(1,2)')).toBe("'=SUM(1,2)");
      expect(sanitizeCellString('+123456789')).toBe("'+123456789");
      expect(sanitizeCellString('-25.00')).toBe("'-25.00");
      expect(sanitizeCellString('@cmd|/c calc')).toBe("'@cmd|/c calc");
      expect(sanitizeCellString('\tcmd')).toBe("'\tcmd");

      // Safe regular string
      expect(sanitizeCellString('Исмоилов Б.')).toBe('Исмоилов Б.');
      expect(sanitizeCellString('№101-A')).toBe('№101-A');
    });
  });

  // =========================================================================
  // 5. БЕЗОПАСНОСТЬ И RBAC (SALES_MANAGER, FINANCE, WAREHOUSE)
  // =========================================================================
  describe('5. RBAC & Anti-Spoofing Security', () => {
    it('enforces RBAC: 403 Forbidden for FINANCE_MANAGER and WAREHOUSE_MANAGER', async () => {
      await expect(SalesManagementExportService.generateSalesManagementWorkbook({}, mockFinance))
        .rejects.toThrow('Доступ к выгрузке аналитики продаж запрещен для вашей роли');

      await expect(SalesManagementExportService.generateSalesManagementWorkbook({}, mockWarehouse))
        .rejects.toThrow('Доступ к выгрузке аналитики продаж запрещен для вашей роли');
    });

    it('enforces RBAC: Sales Manager receives only their own records without foreign PII', async () => {
      const buffer = await SalesManagementExportService.generateSalesManagementWorkbook(
        { date: '2026-10-19', period: '2026-10', managerId: 7 }, // Rep 3 tries to spoof Rep 7
        mockSalesManager
      );

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);

      // Sheet 2: «Менеджеры» — Rep 3 must only see their own row
      const sheet2 = workbook.getWorksheet('Менеджеры');
      // Starting from row 8
      const repRows = [];
      for (let r = 8; r < sheet2.rowCount; r++) {
        const val = sheet2.getCell(`B${r}`).value;
        if (val) repRows.push(val);
      }
      expect(repRows).toContain('Дадоджон Саидов');
      expect(repRows).not.toContain('Алишер Менеджер');
    });
  });

  // =========================================================================
  // 6. ПРАВИЛА БИЗНЕС-ЛОГИКИ (ОТМЕНЫ, БРОНИ, ФАКТ)
  // =========================================================================
  describe('6. Business Rules Compliance', () => {
    it('strictly isolates cancelled deals and reservations from signed contract fact', async () => {
      const buffer = await SalesManagementExportService.generateSalesManagementWorkbook(
        { date: '2026-10-19', period: '2026-10' },
        mockAdmin
      );

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);

      const sheetBlockA = workbook.getWorksheet('Блок А');
      // In Block A: Fact Signed = 1 ($50,000, 65 m2). Deal 303 (CANCELLED, $60,000) must NOT be in fact
      const factRow = sheetBlockA.getRow(8);
      expect(factRow.getCell(3).value).toBe(1); // 1 deal
      const factVolRow = sheetBlockA.getRow(9);
      expect(factVolRow.getCell(3).value).toBe(50000); // $50,000
    });
  });
});
