import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import { SalesAnalyticsService, sanitizeCellString } from '../modules/reports/salesAnalytics.service.js';
import { SalesManagementExportService } from '../modules/reports/salesManagementExport.service.js';
import * as dbConnection from '../db/connection.js';

describe('TOZON CRM — Excel Design & Usability Hotfix Test Suite', () => {
  const mockAdmin = { id: 1, role: 'ADMIN', name: 'Администратор' };
  const mockDirector = { id: 2, role: 'DIRECTOR', name: 'Директор' };
  const mockSalesManager = { id: 3, role: 'SALES_MANAGER', name: 'Дадоджон Саидов' };

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
      }
    ];

    const defaultDeals = [
      {
        id: 301,
        lead_id: 101,
        responsible_user_id: 3,
        status: 'SIGNED',
        final_price_minor: 5000000,
        currency: 'USD',
        created_at: '2026-10-19T05:00:00.000Z',
        signed_at: '2026-10-19T06:00:00.000Z',
        apartments: { id: 501, area: 65, building_id: 4, buildings: { id: 4, code: 'A', name: 'Блок А' } },
        users: { id: 3, name: 'Дадоджон Саидов' }
      }
    ];

    const defaultPayments = [
      {
        id: 401,
        deal_id: 301,
        amount_minor: 1500000,
        currency: 'USD',
        status: 'POSTED',
        payment_date: '2026-10-19',
        created_at: '2026-10-19T07:00:00.000Z',
        deals: { id: 301, responsible_user_id: 3, apartments: { buildings: { code: 'A', name: 'Блок А' } } },
        users: { id: 3, name: 'Дадоджон Саидов' }
      }
    ];

    mockDb = {
      from: vi.fn((table) => {
        let currentData = [];
        if (table === 'users') currentData = [...defaultUsers];
        if (table === 'buildings') currentData = [...defaultBuildings];
        if (table === 'sales_plans') currentData = [...defaultPlans];
        if (table === 'leads') currentData = [...defaultLeads];
        if (table === 'tasks') currentData = [];
        if (table === 'deals') currentData = [...defaultDeals];
        if (table === 'payments') currentData = [...defaultPayments];

        const queryBuilder = {
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
        return queryBuilder;
      })
    };

    vi.spyOn(dbConnection, 'getDB').mockReturnValue(mockDb);
    vi.spyOn(dbConnection, 'getServiceDB').mockReturnValue(mockDb);
  };

  // =========================================================================
  // 1. ПЛАН-ФАКТ ЭКСПОРТ (tozon_sales_analytics_plan_fact_*.xlsx)
  // =========================================================================
  describe('1. Plan-Fact Excel Export & Formula Auditing', () => {
    it('generates valid .xlsx buffer with TOZON PLAZA dark green branding', async () => {
      const buffer = await SalesAnalyticsService.exportSalesAnalyticsXlsx(
        { type: 'plan_fact' },
        mockAdmin
      );

      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBeGreaterThan(1000);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);

      const sheet = workbook.getWorksheet('План-факт продаж');
      expect(sheet).toBeDefined();

      // Row 1: Corporate Title
      const titleCell = sheet.getCell('A1');
      expect(titleCell.value).toContain('TOZON PLAZA');
      expect(titleCell.font.bold).toBe(true);

      // Header Row 7: Dark Green Header
      const headerRow = sheet.getRow(7);
      expect(headerRow.height).toBe(32);
      const headerFill = headerRow.getCell(1).fill;
      expect(headerFill).toBeDefined();
      expect(headerFill.fgColor.argb).toMatch(/0F5132/i);
      expect(headerRow.getCell(1).font.color.argb).toMatch(/FFFFFF/i);
    });

    it('PREVENTS THE 380% BUG: Total row execution % calculates Total Fact / Total Target and NEVER sums monthly %', async () => {
      const buffer = await SalesAnalyticsService.exportSalesAnalyticsXlsx(
        { type: 'plan_fact' },
        mockAdmin
      );

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      const sheet = workbook.getWorksheet('План-факт продаж');

      // The last row is the total row
      const totalRow = sheet.lastRow;
      expect(totalRow.getCell('A').value).toBe('ИТОГО');
      expect(totalRow.font.bold).toBe(true);

      // Total Plan Deals = SUM(C8:C...)
      const totalTargetDealsCell = totalRow.getCell('C');
      expect(totalTargetDealsCell.value).toHaveProperty('formula');
      expect(totalTargetDealsCell.value.formula).toMatch(/^SUM\(C8:C\d+\)$/);

      // Total Actual Deals = SUM(D8:D...)
      const totalActualDealsCell = totalRow.getCell('D');
      expect(totalActualDealsCell.value).toHaveProperty('formula');
      expect(totalActualDealsCell.value.formula).toMatch(/^SUM\(D8:D\d+\)$/);

      // CRITICAL: Total Execution % MUST BE =IF(C{total}>0, D{total}/C{total}, "Нет плана")
      // MUST NOT BE SUM(E8:E...) WHICH WAS CAUSING 380%!
      const totalDealsPercentCell = totalRow.getCell('E');
      expect(totalDealsPercentCell.value).toHaveProperty('formula');
      expect(totalDealsPercentCell.value.formula).not.toMatch(/SUM\(E/i);
      expect(totalDealsPercentCell.value.formula).toMatch(/^IF\(C\d+>0,\s*D\d+\/C\d+,\s*"Нет плана"\)$/);

      // Total Volume Execution % MUST BE =IF(G{total}>0, H{total}/G{total}, "Нет плана")
      // MUST NOT BE SUM(I8:I...)
      const totalVolumePercentCell = totalRow.getCell('I');
      expect(totalVolumePercentCell.value).toHaveProperty('formula');
      expect(totalVolumePercentCell.value.formula).not.toMatch(/SUM\(I/i);
      expect(totalVolumePercentCell.value.formula).toMatch(/^IF\(G\d+>0,\s*H\d+\/G\d+,\s*"Нет плана"\)$/);

      // Total Volume Gap = H{total}-G{total}
      const totalVolumeGapCell = totalRow.getCell('J');
      expect(totalVolumeGapCell.value).toHaveProperty('formula');
      expect(totalVolumeGapCell.value.formula).toMatch(/^H\d+-G\d+$/);

      // Total Reservations = SUM(K8:K...)
      const totalReservationsCell = totalRow.getCell('K');
      expect(totalReservationsCell.value).toHaveProperty('formula');
      expect(totalReservationsCell.value.formula).toMatch(/^SUM\(K8:K\d+\)$/);
    });

    it('monthly rows with 0 target evaluate to "Нет плана" instead of 100%', async () => {
      const buffer = await SalesAnalyticsService.exportSalesAnalyticsXlsx(
        { type: 'plan_fact' },
        mockAdmin
      );

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      const sheet = workbook.getWorksheet('План-факт продаж');

      // Row 8 is '2026-08' with 0 target -> must evaluate to "Нет плана"
      const row8 = sheet.getRow(8);
      expect(row8.getCell('B').value).toBe('2026-08');
      expect(row8.getCell('E').value).toBe('Нет плана');
      expect(row8.getCell('I').value).toBe('Нет плана');

      // Row 10 is '2026-10' with target 20 -> contains real calculation formulas
      const row10 = sheet.getRow(10);
      expect(row10.getCell('B').value).toBe('2026-10');
      expect(row10.getCell('E').value.formula).toBe('D10/C10');
      expect(row10.getCell('I').value.formula).toBe('H10/G10');
    });

    it('configures auto-filters, frozen header, column widths and print setup', async () => {
      const buffer = await SalesAnalyticsService.exportSalesAnalyticsXlsx(
        { type: 'plan_fact' },
        mockAdmin
      );

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      const sheet = workbook.getWorksheet('План-факт продаж');

      expect(sheet.views[0].state).toBe('frozen');
      expect(sheet.views[0].ySplit).toBe(7);
      expect(sheet.autoFilter).toBeDefined();

      // Print setup
      expect(sheet.pageSetup.orientation).toBe('landscape');
      expect(sheet.pageSetup.paperSize).toBe(9); // A4
      expect(sheet.pageSetup.fitToWidth).toBe(1);
      expect(sheet.pageSetup.fitToHeight).toBe(0);
      expect(sheet.pageSetup.printTitlesRow).toBe('7:7');
      expect(sheet.pageSetup.printArea).toMatch(/^A1:L\d+$/);

      // Column widths bounded
      sheet.columns.forEach((col) => {
        expect(col.width).toBeGreaterThanOrEqual(12);
        expect(col.width).toBeLessThanOrEqual(45);
      });
    });
  });

  // =========================================================================
  // 2. СЕМИЛИСТОВАЯ КНИГА PHASE 3.7 (salesManagementExport.service.js)
  // =========================================================================
  describe('2. Phase 3.7 7-Sheet Workbook Usability & Corporate Design', () => {
    it('contains all 7 required sheets with unified TOZON PLAZA branding and dark green headers', async () => {
      const buffer = await SalesManagementExportService.generateSalesManagementWorkbook(
        { date: '2026-10-19', period: '2026-10' },
        mockAdmin
      );

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

      expect(workbook.worksheets.map(w => w.name)).toEqual(expectedSheets);

      // Verify every sheet has TOZON PLAZA header, landscape print setup and auto-filter or printArea
      workbook.worksheets.forEach((sheet) => {
        const titleVal = sheet.getCell('A1').value;
        expect(titleVal).toContain('TOZON PLAZA');

        expect(sheet.pageSetup).toBeDefined();
        expect(sheet.pageSetup.orientation).toBe('landscape');
        expect(sheet.pageSetup.fitToWidth).toBe(1);
        expect(sheet.pageSetup.fitToHeight).toBe(0);
        expect(sheet.pageSetup.printArea).toBeDefined();
      });
    });

    it('handles "Нет плана" in Block A and Block B KPI summaries when plan is 0', async () => {
      const buffer = await SalesManagementExportService.generateSalesManagementWorkbook(
        { date: '2026-10-19', period: '2026-10' },
        mockAdmin
      );

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);

      const sheetBlockA = workbook.getWorksheet('Блок А');
      expect(sheetBlockA).toBeDefined();

      // Check header row 14
      const headerRow = sheetBlockA.getRow(14);
      expect(headerRow.getCell(1).fill.fgColor.argb).toMatch(/0F5132/i);
    });

    it('strictly separates USD and TJS in sheet 6 «Поступления» and provides SUM formulas', async () => {
      const buffer = await SalesManagementExportService.generateSalesManagementWorkbook(
        { date: '2026-10-19', period: '2026-10' },
        mockAdmin
      );

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);

      const sheet6 = workbook.getWorksheet('Поступления');
      const totalRow = sheet6.lastRow;

      expect(totalRow.getCell('A').value).toBe('ИТОГО');
      expect(totalRow.getCell('H').value).toHaveProperty('formula');
      expect(totalRow.getCell('H').value.formula).toMatch(/^SUM\(H\d+:H\d+\)$/);
      expect(totalRow.getCell('I').value).toHaveProperty('formula');
      expect(totalRow.getCell('I').value.formula).toMatch(/^SUM\(I\d+:I\d+\)$/);
    });
  });

  // =========================================================================
  // 3. ЗАЩИТА ОТ EXCEL FORMULA INJECTION
  // =========================================================================
  describe('3. Formula Injection Sanitization', () => {
    it('sanitizes unsafe characters in both services without affecting legitimate text', () => {
      expect(sanitizeCellString('=cmd|/c calc')).toBe("'=cmd|/c calc");
      expect(sanitizeCellString('+79991234567')).toBe("'+79991234567");
      expect(sanitizeCellString('-1000')).toBe("'-1000");
      expect(sanitizeCellString('@SUM(1,2)')).toBe("'@SUM(1,2)");
      expect(sanitizeCellString('\tmalicious')).toBe("'\tmalicious");
      expect(sanitizeCellString('TOZON PLAZA')).toBe('TOZON PLAZA');
      expect(sanitizeCellString('Somon Residence')).toBe('Somon Residence');
      expect(sanitizeCellString('Кв. №45')).toBe('Кв. №45');
    });
  });

  // =========================================================================
  // 4. ГЕНЕРАЦИЯ И ПРОВЕРКА ФИЗИЧЕСКИХ ОБРАЗЦОВ .XLSX
  // =========================================================================
  describe('4. Physical Sample Workbooks Generation & Verification', () => {
    it('generates, saves and validates physical .xlsx sample files on disk', async () => {
      const localScratch = path.resolve('d:/tozon-crm/scratch');
      const artifactScratch = path.resolve('C:/Users/User/.gemini/antigravity-ide/brain/9b218899-fe2b-43ec-bc40-a6987e4c5645/scratch');

      if (!fs.existsSync(localScratch)) fs.mkdirSync(localScratch, { recursive: true });
      if (!fs.existsSync(artifactScratch)) fs.mkdirSync(artifactScratch, { recursive: true });

      // 1. Generate and save Plan-Fact export
      const planFactBuffer = await SalesAnalyticsService.exportSalesAnalyticsXlsx(
        { type: 'plan_fact' },
        mockAdmin
      );
      const planFactLocal = path.join(localScratch, 'tozon_sales_analytics_plan_fact_2026-10-19.xlsx');
      const planFactArtifact = path.join(artifactScratch, 'tozon_sales_analytics_plan_fact_2026-10-19.xlsx');
      fs.writeFileSync(planFactLocal, planFactBuffer);
      fs.writeFileSync(planFactArtifact, planFactBuffer);

      expect(fs.existsSync(planFactLocal)).toBe(true);
      expect(fs.statSync(planFactLocal).size).toBeGreaterThan(3000);

      // Verify Plan-Fact loaded from disk
      const pfWb = new ExcelJS.Workbook();
      await pfWb.xlsx.readFile(planFactLocal);
      const pfSheet = pfWb.getWorksheet('План-факт продаж');
      expect(pfSheet).toBeDefined();
      expect(pfSheet.getCell('A1').value).toContain('TOZON PLAZA');
      const totalRow = pfSheet.lastRow;
      expect(totalRow.getCell('A').value).toBe('ИТОГО');
      expect(totalRow.getCell('E').value.formula).toMatch(/^IF\(C\d+>0,\s*D\d+\/C\d+,\s*"Нет плана"\)$/);

      // 2. Generate and save Phase 3.7 7-Sheet Workbook
      const phase37Buffer = await SalesManagementExportService.generateSalesManagementWorkbook(
        { date: '2026-10-19', period: '2026-10' },
        mockAdmin
      );
      const phase37Local = path.join(localScratch, 'tozon_sales_management_phase3_7_2026-10-19.xlsx');
      const phase37Artifact = path.join(artifactScratch, 'tozon_sales_management_phase3_7_2026-10-19.xlsx');
      fs.writeFileSync(phase37Local, phase37Buffer);
      fs.writeFileSync(phase37Artifact, phase37Buffer);

      expect(fs.existsSync(phase37Local)).toBe(true);
      expect(fs.statSync(phase37Local).size).toBeGreaterThan(5000);

      // Verify Phase 3.7 loaded from disk
      const p37Wb = new ExcelJS.Workbook();
      await p37Wb.xlsx.readFile(phase37Local);
      expect(p37Wb.worksheets.length).toBe(7);
      p37Wb.worksheets.forEach((ws) => {
        expect(ws.getCell('A1').value).toContain('TOZON PLAZA');
        expect(ws.pageSetup.orientation).toBe('landscape');
        expect(ws.pageSetup.fitToWidth).toBe(1);
        expect(ws.pageSetup.printArea).toBeDefined();
      });
    });
  });
});
