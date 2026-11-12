import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  ApartmentSalesReportService,
  normalizeComplexName,
  normalizeBlockCode,
  resolveContractDate
} from '../modules/reports/apartmentSalesReport.service.js';
import { authorizeSectionRequest } from '../middleware/sectionAccess.js';

function makeBuilding({ id, name, code, projectId, projectName, projectCode }) {
  return {
    id,
    name,
    code,
    project_id: projectId,
    archived_at: null,
    projects: {
      id: projectId,
      name: projectName,
      code: projectCode,
      archived_at: null
    }
  };
}

const SAMPLE_BUILDINGS = [
  makeBuilding({
    id: 4,
    name: 'Блок А',
    code: 'БЛОК-А',
    projectId: 3,
    projectName: 'ЖК TOZON PLAZA',
    projectCode: '25601'
  }),
  makeBuilding({
    id: 3,
    name: 'Блок Б',
    code: 'БЛОК-Б',
    projectId: 3,
    projectName: 'ЖК TOZON PLAZA',
    projectCode: '25601'
  }),
  makeBuilding({
    id: 6,
    name: 'Блок В',
    code: 'БЛОК-В',
    projectId: 4,
    projectName: 'ЖК ТОЗОН ПЛАЗА - 2',
    projectCode: 'TOZON-PLAZA-2'
  }),
  makeBuilding({
    id: 7,
    name: 'Блок Г',
    code: 'БЛОК-Г',
    projectId: 4,
    projectName: 'ЖК ТОЗОН ПЛАЗА - 2',
    projectCode: 'TOZON-PLAZA-2'
  })
];

function makeDeal({
  id,
  unitId,
  unitNumber = '101',
  unitKind = 'APARTMENT',
  unitStatus = 'SOLD',
  areaX100 = 6250,
  floorNumber = 3,
  rooms = 2,
  buildingId = 4,
  buildingName = 'Блок А',
  buildingCode = 'БЛОК-А',
  projectId = 3,
  projectName = 'ЖК TOZON PLAZA',
  projectCode = '25601',
  status = 'SIGNED',
  paymentType = 'FULL',
  contractNumber = `ДП-${id}`,
  dealDate = '2026-11-05',
  signedAt = '2026-11-05T10:00:00.000Z',
  createdAt = '2026-11-05T09:00:00.000Z',
  cancelledAt = null
}) {
  return {
    id,
    unit_id: unitId,
    status,
    payment_type: paymentType,
    contract_number: contractNumber,
    deal_date: dealDate,
    signed_at: signedAt,
    created_at: createdAt,
    cancelled_at: cancelledAt,
    units: {
      id: unitId,
      unit_number: unitNumber,
      unit_kind: unitKind,
      rooms,
      area_m2_x100: areaX100,
      status: unitStatus,
      archived_at: null,
      floors: {
        id: 100 + floorNumber,
        floor_number: floorNumber,
        name: `${floorNumber} этаж`,
        sections: {
          id: 10 + buildingId,
          name: 'Секция 1',
          building_id: buildingId,
          buildings: {
            id: buildingId,
            name: buildingName,
            code: buildingCode,
            project_id: projectId,
            projects: {
              id: projectId,
              name: projectName,
              code: projectCode
            }
          }
        }
      }
    }
  };
}

describe('ApartmentSalesReportService — Stage 2.8 Verification Scenarios', () => {
  const fixedNow = new Date('2026-11-13T07:00:00.000Z'); // 2026-11-13 12:00 Asia/Dushanbe

  const dataset = [
    // 1. Block A — Full payment on 2026-11-02 (62.50 m²)
    makeDeal({
      id: 1,
      unitId: 101,
      unitNumber: '12',
      areaX100: 6250,
      floorNumber: 3,
      buildingId: 4,
      buildingName: 'Блок А',
      buildingCode: 'БЛОК-А',
      projectId: 3,
      projectName: 'ЖК TOZON PLAZA',
      contractNumber: 'ДП-001',
      dealDate: '2026-11-02',
      paymentType: 'FULL'
    }),
    // 2. Block A — Installment sale on 2026-11-05 (84.73 m²), entered later on 2026-11-12
    makeDeal({
      id: 2,
      unitId: 102,
      unitNumber: '15',
      areaX100: 8473,
      floorNumber: 4,
      buildingId: 4,
      buildingName: 'Блок А',
      buildingCode: 'БЛОК-А',
      projectId: 3,
      projectName: 'ЖК TOZON PLAZA',
      contractNumber: 'ДП-002',
      dealDate: '2026-11-05',
      signedAt: '2026-11-12T10:00:00Z',
      createdAt: '2026-11-12T10:00:00Z',
      paymentType: 'INSTALLMENT'
    }),
    // 3. Block B — Partial barter sale on 2026-11-05 (71.15 m²)
    makeDeal({
      id: 3,
      unitId: 201,
      unitNumber: '44',
      areaX100: 7115,
      floorNumber: 7,
      buildingId: 3,
      buildingName: 'Блок Б',
      buildingCode: 'БЛОК-Б',
      projectId: 3,
      projectName: 'ЖК TOZON PLAZA',
      contractNumber: 'ДП-003',
      dealDate: '2026-11-05',
      paymentType: 'PARTIAL_BARTER'
    }),
    // 4. Block G (TOZON PLAZA-2) — Sale on 2026-11-10 (53.20 m²)
    makeDeal({
      id: 4,
      unitId: 401,
      unitNumber: '8',
      areaX100: 5320,
      floorNumber: 2,
      buildingId: 7,
      buildingName: 'Блок Г',
      buildingCode: 'БЛОК-Г',
      projectId: 4,
      projectName: 'ЖК ТОЗОН ПЛАЗА - 2',
      projectCode: 'TOZON-PLAZA-2',
      contractNumber: 'ДП-2-001',
      dealDate: '2026-11-10',
      paymentType: 'INSTALLMENT'
    }),
    // 5. Historical sale in October 2026 (outside current month default)
    makeDeal({
      id: 5,
      unitId: 103,
      unitNumber: '19',
      areaX100: 9000,
      floorNumber: 5,
      buildingId: 4,
      buildingName: 'Блок А',
      buildingCode: 'БЛОК-А',
      projectId: 3,
      projectName: 'ЖК TOZON PLAZA',
      contractNumber: 'ДП-OCT-1',
      dealDate: '2026-10-15'
    }),
    // 6. Commercial unit (must be EXCLUDED)
    makeDeal({
      id: 6,
      unitId: 501,
      unitNumber: 'К-1',
      unitKind: 'COMMERCIAL',
      areaX100: 15000,
      floorNumber: 1,
      buildingId: 4,
      buildingName: 'Блок А',
      buildingCode: 'БЛОК-А',
      projectId: 3,
      projectName: 'ЖК TOZON PLAZA',
      contractNumber: 'ДП-КОМ-1',
      dealDate: '2026-11-05'
    }),
    // 7. Parking space (must be EXCLUDED)
    makeDeal({
      id: 7,
      unitId: 601,
      unitNumber: 'П-12',
      unitKind: 'PARKING',
      areaX100: 1800,
      floorNumber: -1,
      buildingId: 3,
      buildingName: 'Блок Б',
      buildingCode: 'БЛОК-Б',
      projectId: 3,
      projectName: 'ЖК TOZON PLAZA',
      contractNumber: 'ДП-ПАРК-12',
      dealDate: '2026-11-05'
    }),
    // 8. Reservation without contract (RESERVED — must be EXCLUDED)
    makeDeal({
      id: 8,
      unitId: 202,
      unitNumber: '45',
      status: 'RESERVED',
      unitStatus: 'RESERVED',
      areaX100: 6500,
      buildingId: 3,
      buildingName: 'Блок Б',
      buildingCode: 'БЛОК-Б',
      projectId: 3,
      projectName: 'ЖК TOZON PLAZA',
      contractNumber: null,
      dealDate: '2026-11-06'
    }),
    // 9. Terminated contract (status CANCELLED — must be EXCLUDED)
    makeDeal({
      id: 9,
      unitId: 203,
      unitNumber: '46',
      status: 'CANCELLED',
      unitStatus: 'FREE',
      cancelledAt: '2026-11-08T12:00:00Z',
      areaX100: 7500,
      buildingId: 3,
      buildingName: 'Блок Б',
      buildingCode: 'БЛОК-Б',
      projectId: 3,
      projectName: 'ЖК TOZON PLAZA',
      contractNumber: 'ДП-РАСТ-1',
      dealDate: '2026-11-03'
    })
  ];

  it('1. Продажи за текущий месяц (default period 1st of month to today in Asia/Dushanbe)', () => {
    const report = ApartmentSalesReportService.computeReport({
      deals: dataset,
      buildings: SAMPLE_BUILDINGS,
      query: {},
      now: fixedNow
    });

    expect(report.filters.startDate).toBe('2026-11-01');
    expect(report.filters.endDate).toBe('2026-11-13');
    expect(report.summary.totalSoldCount).toBe(4);
    // 62.50 + 84.73 + 71.15 + 53.20 = 271.58 m²
    expect(report.summary.totalAreaM2).toBe(271.58);
    // 271.58 / 4 = 67.895 -> 67.90 m²
    expect(report.summary.averageAreaM2).toBe(67.9);

    // Block V has 0 sales and must still appear with zero values
    const blockV = report.blocks.find((b) => b.blockCode === 'В');
    expect(blockV).toBeDefined();
    expect(blockV.projectName).toBe('TOZON PLAZA-2');
    expect(blockV.soldCount).toBe(0);
    expect(blockV.soldAreaM2).toBe(0);
  });

  it('2. Продажи за один день (both boundary dates equal and inclusive)', () => {
    const report = ApartmentSalesReportService.computeReport({
      deals: dataset,
      buildings: SAMPLE_BUILDINGS,
      query: { startDate: '2026-11-05', endDate: '2026-11-05' },
      now: fixedNow
    });

    expect(report.summary.totalSoldCount).toBe(2);
    // Deal #2 (84.73) + Deal #3 (71.15) = 155.88 m²
    expect(report.summary.totalAreaM2).toBe(155.88);
    expect(report.summary.averageAreaM2).toBe(77.94);
  });

  it('3. Продажи за произвольный период (including October + November)', () => {
    const report = ApartmentSalesReportService.computeReport({
      deals: dataset,
      buildings: SAMPLE_BUILDINGS,
      query: { startDate: '2026-10-01', endDate: '2026-11-10' },
      now: fixedNow
    });

    expect(report.summary.totalSoldCount).toBe(5);
    // 271.58 + 90.00 = 361.58 m²
    expect(report.summary.totalAreaM2).toBe(361.58);
    // 361.58 / 5 = 72.316 -> 72.32 m²
    expect(report.summary.averageAreaM2).toBe(72.32);
  });

  it('4. Фильтр по отдельному блоку (Блок А)', () => {
    const report = ApartmentSalesReportService.computeReport({
      deals: dataset,
      buildings: SAMPLE_BUILDINGS,
      query: { startDate: '2026-11-01', endDate: '2026-11-13', block: 'А' },
      now: fixedNow
    });

    expect(report.blocks).toHaveLength(1);
    expect(report.blocks[0].blockCode).toBe('А');
    expect(report.summary.totalSoldCount).toBe(2);
    // 62.50 + 84.73 = 147.23 m²
    expect(report.summary.totalAreaM2).toBe(147.23);
    expect(report.summary.averageAreaM2).toBe(73.62);
  });

  it('5. Фильтр по отдельному комплексу (TOZON PLAZA-2)', () => {
    const report = ApartmentSalesReportService.computeReport({
      deals: dataset,
      buildings: SAMPLE_BUILDINGS,
      query: { startDate: '2026-11-01', endDate: '2026-11-13', complex: 'TOZON PLAZA-2' },
      now: fixedNow
    });

    expect(report.blocks.map((b) => b.blockCode)).toEqual(['В', 'Г']);
    expect(report.summary.totalSoldCount).toBe(1);
    expect(report.summary.totalAreaM2).toBe(53.2);
    expect(report.summary.averageAreaM2).toBe(53.2);
  });

  it('6. Период без продаж (returns 0 counts and 0.00 areas for all blocks without NaN)', () => {
    const report = ApartmentSalesReportService.computeReport({
      deals: dataset,
      buildings: SAMPLE_BUILDINGS,
      query: { startDate: '2025-01-01', endDate: '2025-01-31' },
      now: fixedNow
    });

    expect(report.summary.totalSoldCount).toBe(0);
    expect(report.summary.totalAreaM2).toBe(0);
    expect(report.summary.averageAreaM2).toBe(0);
    expect(report.blocks).toHaveLength(4);
    for (const b of report.blocks) {
      expect(b.soldCount).toBe(0);
      expect(b.soldAreaM2).toBe(0);
      expect(b.apartments).toHaveLength(0);
    }
  });

  it('7. Несколько договоров по одной квартире (deduplicates unit_id and excludes cancelled history)', () => {
    const multiDealDataset = [
      // Earlier cancelled contract on unit 777
      makeDeal({
        id: 70,
        unitId: 777,
        unitNumber: '77',
        status: 'CANCELLED',
        cancelledAt: '2026-11-03T10:00:00Z',
        areaX100: 6400,
        contractNumber: 'ДП-77-OLD',
        dealDate: '2026-11-01'
      }),
      // Duplicate SIGNED entry on unit 777 (e.g. re-entered contract)
      makeDeal({
        id: 71,
        unitId: 777,
        unitNumber: '77',
        status: 'SIGNED',
        areaX100: 6400,
        contractNumber: 'ДП-77-V1',
        dealDate: '2026-11-04',
        signedAt: '2026-11-04T09:00:00Z'
      }),
      makeDeal({
        id: 72,
        unitId: 777,
        unitNumber: '77',
        status: 'SIGNED',
        areaX100: 6400,
        contractNumber: 'ДП-77-ACTIVE',
        dealDate: '2026-11-06',
        signedAt: '2026-11-06T12:00:00Z'
      })
    ];

    const report = ApartmentSalesReportService.computeReport({
      deals: multiDealDataset,
      buildings: SAMPLE_BUILDINGS,
      query: { startDate: '2026-11-01', endDate: '2026-11-13' },
      now: fixedNow
    });

    expect(report.summary.totalSoldCount).toBe(1);
    expect(report.summary.totalAreaM2).toBe(64);
    expect(report.apartments).toHaveLength(1);
    expect(report.apartments[0].contractNumber).toBe('ДП-77-ACTIVE');
  });

  it('8. Расторгнутый договор исключается из продаж (terminated contract via status or unit FREE)', () => {
    const terminatedDataset = [
      makeDeal({
        id: 80,
        unitId: 888,
        unitNumber: '88',
        status: 'CANCELLED',
        unitStatus: 'FREE',
        cancelledAt: '2026-11-09T10:00:00Z',
        areaX100: 5500,
        dealDate: '2026-11-02'
      }),
      // Edge case: deal status still SIGNED in legacy row, but unit was returned to FREE
      makeDeal({
        id: 81,
        unitId: 889,
        unitNumber: '89',
        status: 'SIGNED',
        unitStatus: 'FREE',
        areaX100: 5800,
        dealDate: '2026-11-03'
      })
    ];

    const report = ApartmentSalesReportService.computeReport({
      deals: terminatedDataset,
      buildings: SAMPLE_BUILDINGS,
      query: { startDate: '2026-11-01', endDate: '2026-11-13' },
      now: fixedNow
    });

    expect(report.summary.totalSoldCount).toBe(0);
    expect(report.summary.totalAreaM2).toBe(0);
  });

  it('9. Продажа в рассрочку учитывается наравне с полной оплатой', () => {
    const report = ApartmentSalesReportService.computeReport({
      deals: dataset,
      buildings: SAMPLE_BUILDINGS,
      query: { startDate: '2026-11-01', endDate: '2026-11-13' },
      now: fixedNow
    });

    const paymentTypes = report.apartments.map((a) => a.paymentType);
    expect(paymentTypes).toContain('INSTALLMENT');
    expect(paymentTypes).toContain('PARTIAL_BARTER');
    expect(paymentTypes).toContain('FULL');
  });

  it('10. Совпадение детализации со сводной суммой и отсутствие персональных данных покупателей', () => {
    const report = ApartmentSalesReportService.computeReport({
      deals: dataset,
      buildings: SAMPLE_BUILDINGS,
      query: { startDate: '2026-11-01', endDate: '2026-11-13' },
      now: fixedNow
    });

    const sumBlockCounts = report.blocks.reduce((acc, b) => acc + b.soldCount, 0);
    const sumBlockAreas = Number(
      report.blocks.reduce((acc, b) => acc + b.soldAreaM2, 0).toFixed(2)
    );
    const sumDrilldownAreas = Number(
      report.apartments.reduce((acc, a) => acc + a.areaM2, 0).toFixed(2)
    );

    expect(sumBlockCounts).toBe(report.summary.totalSoldCount);
    expect(sumBlockCounts).toBe(report.totals.soldCount);
    expect(report.apartments.length).toBe(report.summary.totalSoldCount);
    expect(sumBlockAreas).toBe(report.summary.totalAreaM2);
    expect(sumDrilldownAreas).toBe(report.summary.totalAreaM2);

    // Ensure no buyer PII fields leak in apartment drilldown items
    for (const apt of report.apartments) {
      expect(apt).not.toHaveProperty('lead_name');
      expect(apt).not.toHaveProperty('lead_phone');
      expect(apt).not.toHaveProperty('passport_number');
      expect(apt).not.toHaveProperty('inn');
    }
  });

  it('11. Округление площадей до 2 знаков после запятой и генерация Excel (.xlsx) с 2 листами', async () => {
    const report = ApartmentSalesReportService.computeReport({
      deals: dataset,
      buildings: SAMPLE_BUILDINGS,
      query: { startDate: '2026-11-01', endDate: '2026-11-13' },
      now: fixedNow
    });

    const buffer = await ApartmentSalesReportService.generateExcelWorkbook(
      report.filters,
      null,
      null,
      report
    );

    expect(buffer).toBeDefined();
    expect(buffer.byteLength).toBeGreaterThan(1000);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
      'Сводный отчёт',
      'Детализация квартир'
    ]);

    const summarySheet = workbook.getWorksheet('Сводный отчёт');
    expect(summarySheet.getCell('A1').value).toBe('ОТЧЁТ О ПРОДАЖАХ КВАРТИР');

    const detailsSheet = workbook.getWorksheet('Детализация квартир');
    expect(String(detailsSheet.getCell('A1').value)).toContain('ДЕТАЛИЗАЦИЯ ПРОДАННЫХ КВАРТИР');
    // Header row (4) + 4 apartments + 1 total row = 9 rows
    expect(detailsSheet.rowCount).toBe(9);
  });

  it('12. Валидация некорректного периода и нормализация кодов комплексов/блоков', () => {
    expect(() =>
      ApartmentSalesReportService.resolveFilters({
        startDate: '2026-11-15',
        endDate: '2026-11-01'
      })
    ).toThrow(/не может быть позже/);

    expect(normalizeComplexName('ЖК ТОЗОН ПЛАЗА - 2')).toBe('TOZON PLAZA-2');
    expect(normalizeComplexName('ЖК TOZON PLAZA')).toBe('TOZON PLAZA');
    expect(normalizeBlockCode('БЛОК-Г')).toBe('Г');
    expect(normalizeBlockCode('Блок Б')).toBe('Б');
    expect(
      resolveContractDate({
        deal_date: '2026-02-03',
        signed_at: '2026-08-27T10:00:00Z'
      })
    ).toBe('2026-02-03');
  });

  it('13. Проверка авторизации (sectionAccess) для /api/reports/apartment-sales и export.xlsx', async () => {
    const directorReq = {
      method: 'GET',
      originalUrl: '/api/reports/apartment-sales?startDate=2026-11-01&endDate=2026-11-13',
      user: {
        role: 'DIRECTOR',
        permissions: ['access.v2', 'analytics.view', 'analytics.reports']
      }
    };
    await expect(authorizeSectionRequest(directorReq)).resolves.toBeUndefined();
    expect(directorReq.sectionAccessGranted).toBe(true);

    const financeReq = {
      method: 'GET',
      originalUrl: '/api/reports/apartment-sales/export.xlsx',
      user: {
        role: 'FINANCE_MANAGER',
        permissions: ['access.v2', 'analytics.view', 'analytics.reports', 'finance.view']
      }
    };
    await expect(authorizeSectionRequest(financeReq)).resolves.toBeUndefined();
    expect(financeReq.sectionAccessGranted).toBe(true);

    const warehouseDeniedReq = {
      method: 'GET',
      originalUrl: '/api/reports/apartment-sales',
      user: {
        role: 'WAREHOUSE_MANAGER',
        permissions: ['access.v2', 'construction.stock']
      }
    };
    await expect(authorizeSectionRequest(warehouseDeniedReq)).rejects.toThrow(/Нет права чтения/);
  });
});

