import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  ApartmentSalesReportService,
  normalizeComplexName,
  normalizeBlockCode,
  resolveContractDate
} from '../modules/reports/apartmentSalesReport.service.js';
import {
  MarketingAttributionService,
  resolveDealAttributionAndCommission,
  computeTieredCommissionRateBp,
  SALES_SOURCES,
  COMMISSION_STATUSES,
  AUDIT_ACTION_SALES_SOURCE,
  AUDIT_ACTION_COMMISSION,
} from '../modules/reports/marketingAttribution.service.js';
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

function makeUnit({
  id,
  unitNumber = '101',
  unitKind = 'APARTMENT',
  status = 'AVAILABLE',
  areaX100 = 6250,
  floorNumber = 3,
  rooms = 2,
  buildingId = 4,
  buildingName = 'Блок А',
  buildingCode = 'БЛОК-А',
  projectId = 3,
  projectName = 'ЖК TOZON PLAZA',
  projectCode = '25601',
  availableFrom = null,
  blockedAt = null
}) {
  return {
    id,
    unit_number: unitNumber,
    unit_kind: unitKind,
    rooms,
    area_m2_x100: areaX100,
    status,
    available_from: availableFrom,
    blocked_at: blockedAt,
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
  };
}

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
  cancelledAt = null,
  reservationExpiresAt = null,
  basePriceMinor = 5000000,
  discountMinor = 0,
  finalPriceMinor = 5000000,
  downPaymentMinor = 0,
  barterAmountMinor = 0,
  refundAmountMinor = 0,
  payments = []
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
    reservation_expires_at: reservationExpiresAt,
    base_price_minor: basePriceMinor,
    discount_minor: discountMinor,
    final_price_minor: finalPriceMinor,
    down_payment_minor: downPaymentMinor,
    barter_amount_minor: barterAmountMinor,
    refund_amount_minor: refundAmountMinor,
    currency: 'USD',
    payments,
    units: makeUnit({
      id: unitId,
      unitNumber,
      unitKind,
      status: unitStatus,
      areaX100,
      floorNumber,
      rooms,
      buildingId,
      buildingName,
      buildingCode,
      projectId,
      projectName,
      projectCode
    })
  };
}

describe('ApartmentSalesReportService — Stage 2 & Financial Expansion Verification Scenarios', () => {
  const fixedNow = new Date('2026-11-13T07:00:00.000Z'); // 2026-11-13 12:00 Asia/Dushanbe

  const dataset = [
    // 1. Block A — Full payment on 2026-11-02 (62.50 m², $50,000, paid $50,000 cash)
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
      paymentType: 'FULL',
      finalPriceMinor: 5000000,
      downPaymentMinor: 5000000,
      payments: [
        {
          id: 1001,
          deal_id: 1,
          amount_minor: 5000000,
          currency: 'USD',
          payment_date: '2026-11-02',
          payment_method: 'CASH',
          settlement_method: 'CASH',
          status: 'ACTIVE'
        }
      ]
    }),
    // 2. Block A — Installment sale on 2026-11-05 (84.73 m², $60,000, paid $15,000 cash on 2026-11-05, $5,000 after period on 2026-11-20)
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
      paymentType: 'INSTALLMENT',
      finalPriceMinor: 6000000,
      downPaymentMinor: 1500000,
      payments: [
        {
          id: 1002,
          deal_id: 2,
          amount_minor: 1500000,
          currency: 'USD',
          payment_date: '2026-11-05',
          payment_method: 'CASH',
          settlement_method: 'CASH',
          status: 'ACTIVE'
        },
        {
          id: 1003,
          deal_id: 2,
          amount_minor: 500000,
          currency: 'USD',
          payment_date: '2026-11-20', // AFTER period endDate (2026-11-13)
          payment_method: 'CASH',
          settlement_method: 'CASH',
          status: 'ACTIVE'
        }
      ]
    }),
    // 3. Block B — Partial barter sale on 2026-11-05 (71.15 m², $40,000: $10,000 cash + $15,000 barter = $25,000 settled, $15,000 debt)
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
      paymentType: 'PARTIAL_BARTER',
      finalPriceMinor: 4000000,
      barterAmountMinor: 1500000,
      payments: [
        {
          id: 1004,
          deal_id: 3,
          amount_minor: 1000000,
          currency: 'USD',
          payment_date: '2026-11-05',
          payment_method: 'CASH',
          settlement_method: 'CASH',
          status: 'ACTIVE'
        },
        {
          id: 1005,
          deal_id: 3,
          amount_minor: 1500000,
          currency: 'USD',
          payment_date: '2026-11-05',
          payment_method: 'CASH',
          settlement_method: 'CASH',
          cash_desk_id: 'a8ac44fb-8da6-42a8-9243-353202383b58', // Barter Cash Desk
          comment: '[Касса: Бартерная касса]',
          status: 'ACTIVE'
        }
      ]
    }),
    // 4. Block G (TOZON PLAZA-2) — Sale with 0 down payment on 2026-11-10 (53.20 m², $30,000, paid $0, debt $30,000)
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
      paymentType: 'INSTALLMENT',
      finalPriceMinor: 3000000,
      downPaymentMinor: 0,
      payments: []
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
      dealDate: '2026-10-15',
      finalPriceMinor: 7000000,
      payments: [
        {
          id: 1006,
          deal_id: 5,
          amount_minor: 7000000,
          currency: 'USD',
          payment_date: '2026-10-15',
          status: 'ACTIVE'
        }
      ]
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
      dealDate: '2026-11-05',
      finalPriceMinor: 12000000
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
      dealDate: '2026-11-05',
      finalPriceMinor: 1000000
    }),
    // 8. Reservation without contract (RESERVED — must be EXCLUDED from sales)
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
      dealDate: '2026-11-06',
      finalPriceMinor: 4200000
    }),
    // 9. Terminated contract (status CANCELLED — must be EXCLUDED from sales)
    makeDeal({
      id: 9,
      unitId: 203,
      unitNumber: '46',
      status: 'CANCELLED',
      unitStatus: 'AVAILABLE',
      cancelledAt: '2026-11-08T12:00:00Z',
      areaX100: 7500,
      buildingId: 3,
      buildingName: 'Блок Б',
      buildingCode: 'БЛОК-Б',
      projectId: 3,
      projectName: 'ЖК TOZON PLAZA',
      contractNumber: 'ДП-РАСТ-1',
      dealDate: '2026-10-20',
      finalPriceMinor: 4800000
    })
  ];

  it('1. Продажи и финансовые показатели за текущий месяц (default period 1st of month to today)', () => {
    const report = ApartmentSalesReportService.computeReport({
      deals: dataset,
      buildings: SAMPLE_BUILDINGS,
      query: {},
      now: fixedNow
    });

    expect(report.filters.startDate).toBe('2026-11-01');
    expect(report.filters.endDate).toBe('2026-11-13');
    expect(report.summary.totalSoldCount).toBe(4);
    expect(report.summary.totalAreaM2).toBe(271.58);
    expect(report.summary.averageAreaM2).toBe(67.9);

    // Sales amount: $50,000 + $60,000 + $40,000 + $30,000 = $180,000
    expect(report.summary.totalSalesAmountUsd).toBe(180000);
    // Paid cash as of 2026-11-13: $50,000 + $15,000 (the $5,000 on 2026-11-20 is excluded!) + $10,000 + $0 = $75,000
    expect(report.summary.totalPaidCashUsd).toBe(75000);
    // Paid barter as of 2026-11-13: $15,000 (not double-counted despite barter_amount_minor AND barter payment row)
    expect(report.summary.totalPaidBarterUsd).toBe(15000);
    // Total settled: $75,000 + $15,000 = $90,000 (50.00%)
    expect(report.summary.totalSettledUsd).toBe(90000);
    expect(report.summary.totalPaidPercent).toBe(50);
    // Remaining debt: $180,000 - $90,000 = $90,000 (50.00%)
    expect(report.summary.totalRemainingDebtUsd).toBe(90000);
    expect(report.summary.totalDebtPercent).toBe(50);

    // Block V has 0 sales and must appear with 0 values and 0% without NaN
    const blockV = report.blocks.find((b) => b.blockCode === 'В');
    expect(blockV).toBeDefined();
    expect(blockV.soldCount).toBe(0);
    expect(blockV.salesAmountUsd).toBe(0);
    expect(blockV.totalSettledUsd).toBe(0);
    expect(blockV.remainingDebtUsd).toBe(0);
    expect(blockV.paidPercent).toBe(0);
    expect(blockV.debtPercent).toBe(0);
  });

  it('2. Исторический учёт свободных квартир на начало и конец периода (продажи, бронирования, расторжения, BLOCKED)', () => {
    const unitsInBlockA = [
      // 1. Sold before period (2026-10-15) -> occupied at start and end
      makeUnit({ id: 103, unitNumber: '19', status: 'SOLD', buildingId: 4, buildingCode: 'БЛОК-А' }),
      // 2. Sold during period (2026-11-02) -> available at start, occupied at end
      makeUnit({ id: 101, unitNumber: '12', status: 'SOLD', buildingId: 4, buildingCode: 'БЛОК-А' }),
      // 3. Sold during period (2026-11-05) -> available at start, occupied at end
      makeUnit({ id: 102, unitNumber: '15', status: 'SOLD', buildingId: 4, buildingCode: 'БЛОК-А' }),
      // 4. Terminated during period (signed 2026-10-20, cancelled 2026-11-08) -> occupied at start (2026-11-01), available at end (2026-11-13)!
      makeUnit({ id: 203, unitNumber: '46', status: 'AVAILABLE', buildingId: 4, buildingCode: 'БЛОК-А' }),
      // 5. Blocked apartment -> excluded from available at start and end
      makeUnit({ id: 109, unitNumber: '99', status: 'BLOCKED', buildingId: 4, buildingCode: 'БЛОК-А' }),
      // 6. Always available apartment -> available at start and end
      makeUnit({ id: 110, unitNumber: '100', status: 'AVAILABLE', buildingId: 4, buildingCode: 'БЛОК-А' })
    ];

    const dealsForBlockA = [
      dataset[0], // unit 101 sold 2026-11-02
      dataset[1], // unit 102 sold 2026-11-05
      dataset[4], // unit 103 sold 2026-10-15
      {
        ...dataset[8], // unit 203 signed 2026-10-20, cancelled 2026-11-08 in Block A
        units: unitsInBlockA[3]
      }
    ];

    const report = ApartmentSalesReportService.computeReport({
      deals: dealsForBlockA,
      units: unitsInBlockA,
      buildings: [SAMPLE_BUILDINGS[0]],
      query: { startDate: '2026-11-01', endDate: '2026-11-13', block: 'А' },
      now: fixedNow
    });

    const blockA = report.blocks[0];
    expect(blockA.totalApartments).toBe(6);
    expect(blockA.blockedCount).toBe(1);
    expect(blockA.sellableApartments).toBe(5);
    // At start (2026-11-01 00:00): units 101, 102, 110 are available (3 units). Units 103 and 203 are occupied by contracts. Unit 109 is BLOCKED.
    expect(blockA.availableStartCount).toBe(3);
    // Sold during period: units 101 and 102 (2 units).
    expect(blockA.soldCount).toBe(2);
    // Cancelled during period: unit 203 returned to free inventory (+1 unit).
    expect(blockA.cancelledInPeriodCount).toBe(1);
    // At end (2026-11-13 23:59): 3 (start) - 2 (sold) + 1 (cancelled/returned) = 2 available (units 203 and 110)!
    expect(blockA.availableEndCount).toBe(2);
  });

  it('3. Платёж после даты окончания периода НЕ включается в «Получено» на конец выбранного периода', () => {
    // When endDate is 2026-11-13, Deal #2 has $15,000 paid on 2026-11-05 and $5,000 paid on 2026-11-20
    const reportAsOfNov13 = ApartmentSalesReportService.computeReport({
      deals: [dataset[1]],
      buildings: SAMPLE_BUILDINGS,
      query: { startDate: '2026-11-01', endDate: '2026-11-13', block: 'А' },
      now: fixedNow
    });
    expect(reportAsOfNov13.summary.totalSettledUsd).toBe(15000);
    expect(reportAsOfNov13.summary.totalRemainingDebtUsd).toBe(45000);
    expect(reportAsOfNov13.summary.totalPaidPercent).toBe(25);
    expect(reportAsOfNov13.summary.totalDebtPercent).toBe(75);

    // When endDate is extended to 2026-11-25, the $5,000 payment on 2026-11-20 IS included ($20,000 total)
    const reportAsOfNov25 = ApartmentSalesReportService.computeReport({
      deals: [dataset[1]],
      buildings: SAMPLE_BUILDINGS,
      query: { startDate: '2026-11-01', endDate: '2026-11-25', block: 'А' },
      now: fixedNow
    });
    expect(reportAsOfNov25.summary.totalSettledUsd).toBe(20000);
    expect(reportAsOfNov25.summary.totalRemainingDebtUsd).toBe(40000);
    expect(reportAsOfNov25.summary.totalPaidPercent).toBe(33.33);
    expect(reportAsOfNov25.summary.totalDebtPercent).toBe(66.67);
  });

  it('4. Отсутствие двойного учёта первоначального взноса (down_payment_minor) и аннулированных ПКО (VOIDED)', () => {
    const dealWithVoidedAndDownPayment = makeDeal({
      id: 30,
      unitId: 301,
      unitNumber: '31',
      finalPriceMinor: 5000000, // $50,000
      downPaymentMinor: 2000000, // $20,000 declared in deal header
      payments: [
        {
          id: 2001,
          deal_id: 30,
          amount_minor: 2000000, // $20,000 PKO for initial payment
          payment_date: '2026-11-05',
          status: 'ACTIVE'
        },
        {
          id: 2002,
          deal_id: 30,
          amount_minor: 1000000, // $10,000 voided PKO
          payment_date: '2026-11-06',
          status: 'VOIDED'
        }
      ]
    });

    const report = ApartmentSalesReportService.computeReport({
      deals: [dealWithVoidedAndDownPayment],
      buildings: SAMPLE_BUILDINGS,
      query: { startDate: '2026-11-01', endDate: '2026-11-13', block: 'А' },
      now: fixedNow
    });

    // Must be $20,000, NOT $40,000 (no double count of downPaymentMinor) and NOT $30,000 (VOIDED excluded)
    expect(report.summary.totalPaidCashUsd).toBe(20000);
    expect(report.summary.totalSettledUsd).toBe(20000);
    expect(report.summary.totalRemainingDebtUsd).toBe(30000);
    expect(report.summary.totalPaidPercent).toBe(40);
    expect(report.summary.totalDebtPercent).toBe(60);
  });

  it('5. Частичный возврат (refund_amount_minor) и защита от отрицательного долга при переплате', () => {
    const dealWithRefund = makeDeal({
      id: 40,
      unitId: 410,
      unitNumber: '41',
      finalPriceMinor: 4000000, // $40,000
      refundAmountMinor: 500000, // $5,000 refunded
      payments: [
        {
          id: 3001,
          deal_id: 40,
          amount_minor: 2500000, // $25,000 paid
          payment_date: '2026-11-04',
          status: 'ACTIVE'
        }
      ]
    });

    const dealWithOverpayment = makeDeal({
      id: 41,
      unitId: 411,
      unitNumber: '42',
      finalPriceMinor: 3000000, // $30,000
      payments: [
        {
          id: 3002,
          deal_id: 41,
          amount_minor: 3150000, // $31,500 paid ($1,500 overpayment)
          payment_date: '2026-11-04',
          status: 'ACTIVE'
        }
      ]
    });

    const report = ApartmentSalesReportService.computeReport({
      deals: [dealWithRefund, dealWithOverpayment],
      buildings: SAMPLE_BUILDINGS,
      query: { startDate: '2026-11-01', endDate: '2026-11-13', block: 'А' },
      now: fixedNow
    });

    const aptRefund = report.apartments.find((a) => a.unitId === 410);
    // $25,000 - $5,000 refund = $20,000 net paid, $20,000 debt
    expect(aptRefund.paidCashUsd).toBe(20000);
    expect(aptRefund.remainingDebtUsd).toBe(20000);
    expect(aptRefund.paidPercent).toBe(50);

    const aptOverpaid = report.apartments.find((a) => a.unitId === 411);
    // Debt must be 0 (never negative!), overpaidUsd = 1500, paidPercent = 100%
    expect(aptOverpaid.remainingDebtUsd).toBe(0);
    expect(aptOverpaid.overpaidUsd).toBe(1500);
    expect(aptOverpaid.paidPercent).toBe(100);
    expect(aptOverpaid.debtPercent).toBe(0);
  });

  it('6. Совпадение детализации и сводной таблицы по каждому блоку и по строке ИТОГО', () => {
    const report = ApartmentSalesReportService.computeReport({
      deals: dataset,
      buildings: SAMPLE_BUILDINGS,
      query: { startDate: '2026-11-01', endDate: '2026-11-13' },
      now: fixedNow
    });

    for (const block of report.blocks) {
      const sumArea = Number(block.apartments.reduce((s, a) => s + a.areaM2, 0).toFixed(2));
      const sumSales = Number(block.apartments.reduce((s, a) => s + a.contractPriceUsd, 0).toFixed(2));
      const sumCash = Number(block.apartments.reduce((s, a) => s + a.paidCashUsd, 0).toFixed(2));
      const sumBarter = Number(block.apartments.reduce((s, a) => s + a.paidBarterUsd, 0).toFixed(2));
      const sumSettled = Number(block.apartments.reduce((s, a) => s + a.totalSettledUsd, 0).toFixed(2));
      const sumDebt = Number(block.apartments.reduce((s, a) => s + a.remainingDebtUsd, 0).toFixed(2));

      expect(block.soldCount).toBe(block.apartments.length);
      expect(block.soldAreaM2).toBe(sumArea);
      expect(block.salesAmountUsd).toBe(sumSales);
      expect(block.paidCashUsd).toBe(sumCash);
      expect(block.paidBarterUsd).toBe(sumBarter);
      expect(block.totalSettledUsd).toBe(sumSettled);
      expect(block.remainingDebtUsd).toBe(sumDebt);
    }

    const totalSalesFromBlocks = Number(report.blocks.reduce((s, b) => s + b.salesAmountUsd, 0).toFixed(2));
    const totalSettledFromBlocks = Number(report.blocks.reduce((s, b) => s + b.totalSettledUsd, 0).toFixed(2));
    const totalDebtFromBlocks = Number(report.blocks.reduce((s, b) => s + b.remainingDebtUsd, 0).toFixed(2));

    expect(report.totals.salesAmountUsd).toBe(totalSalesFromBlocks);
    expect(report.totals.totalSettledUsd).toBe(totalSettledFromBlocks);
    expect(report.totals.remainingDebtUsd).toBe(totalDebtFromBlocks);
  });

  it('7. Генерация Excel (.xlsx) с 4 листами (Сводный отчёт, Детализация квартир, Источники продаж, Комиссии маркетологов)', async () => {
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
      'Детализация квартир',
      'Источники продаж',
      'Комиссии маркетологов'
    ]);

    const summarySheet = workbook.getWorksheet('Сводный отчёт');
    expect(summarySheet.getCell('A1').value).toBe('ОТЧЁТ О ПРОДАЖАХ КВАРТИР И КОМИССИЯХ МАРКЕТОЛОГОВ');
    expect(summarySheet.pageSetup.orientation).toBe('landscape');

    const detailsSheet = workbook.getWorksheet('Детализация квартир');
    expect(String(detailsSheet.getCell('A1').value)).toContain('ДЕТАЛИЗАЦИЯ ПРОДАННЫХ КВАРТИР');
    expect(detailsSheet.pageSetup.orientation).toBe('landscape');
    expect(detailsSheet.rowCount).toBe(9);

    const sourcesSheet = workbook.getWorksheet('Источники продаж');
    expect(String(sourcesSheet.getCell('A1').value)).toContain('АНАЛИТИКА ПО ИСТОЧНИКАМ ПРОДАЖ');

    const commissionsSheet = workbook.getWorksheet('Комиссии маркетологов');
    expect(String(commissionsSheet.getCell('A1').value)).toContain('КОНТРОЛЬ КОМИССИЙ МАРКЕТОЛОГОВ');
  });

  it('8. Валидация некорректного периода, нормализация и авторизация (sectionAccess)', async () => {
    expect(() =>
      ApartmentSalesReportService.resolveFilters({
        startDate: '2026-11-15',
        endDate: '2026-11-01'
      })
    ).toThrow(/не может быть позже/);

    expect(normalizeComplexName('ЖК ТОЗОН ПЛАЗА - 2')).toBe('TOZON PLAZA-2');
    expect(normalizeComplexName('ЖК TOZON PLAZA')).toBe('TOZON PLAZA');
    expect(normalizeBlockCode('БЛОК-Г')).toBe('Г');
    expect(
      resolveContractDate({
        deal_date: '2026-02-03',
        signed_at: '2026-08-27T10:00:00Z'
      })
    ).toBe('2026-02-03');

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
  });

  it('9. [V3] Прямая продажа TOZON (DIRECT), Продажа через маркетолога (MARKETER) и Источник не определён (UNSPECIFIED)', () => {
    const partnersMap = new Map([
      [
        501,
        {
          id: 501,
          name: 'Agency Alpha',
          isActive: true,
          commissionType: 'PERCENT',
          commissionRateBp: 300, // 3.00%
          commissionRatePercent: 3,
          commissionFixedMinor: 0,
        },
      ],
      [
        502,
        {
          id: 502,
          name: 'Partner ZeroRate (Без согласованной ставки)',
          isActive: true,
          commissionType: 'NONE',
          commissionRateBp: 0,
          commissionRatePercent: 0,
          commissionFixedMinor: 0,
        },
      ],
    ]);

    // 9a. Direct sale TOZON -> 0 USD commission
    const directAttr = resolveDealAttributionAndCommission({
      deal: { id: 1001, status: 'SIGNED', final_price_minor: 5000000 }, // $50,000
      auditLogs: [
        {
          id: 1,
          deal_id: 1001,
          action: AUDIT_ACTION_SALES_SOURCE,
          changes_json: { new_source: SALES_SOURCES.DIRECT },
          created_at: '2026-11-05T10:00:00Z',
        },
      ],
      partnersMap,
    });
    expect(directAttr.salesSource).toBe(SALES_SOURCES.DIRECT);
    expect(directAttr.commission.calculatedCommissionUsd).toBe(0);
    expect(directAttr.commission.approvedCommissionUsd).toBe(0);
    expect(directAttr.commission.remainingCommissionUsd).toBe(0);
    expect(directAttr.commission.status).toBe(COMMISSION_STATUSES.NOT_CALCULATED);

    // 9b. Unspecified sale (historical contract) -> 0 USD commission, NOT auto-calculated
    const unspecifiedAttr = resolveDealAttributionAndCommission({
      deal: { id: 1002, status: 'SIGNED', final_price_minor: 6000000 }, // $60,000
      auditLogs: [],
      partnersMap,
    });
    expect(unspecifiedAttr.salesSource).toBe(SALES_SOURCES.UNSPECIFIED);
    expect(unspecifiedAttr.commission.calculatedCommissionUsd).toBe(0);
    expect(unspecifiedAttr.commission.status).toBe(COMMISSION_STATUSES.NOT_CALCULATED);

    // 9c. Marketer sale with Partner #501 (10% paid -> 3% of $50,000 = $1,500), approved and $500 paid -> $1,000 remaining
    const marketerAttr = resolveDealAttributionAndCommission({
      deal: {
        id: 1003,
        status: 'SIGNED',
        final_price_minor: 5000000,
        payments: [{ id: 1, amount_minor: 500000, payment_date: '2026-11-06', status: 'ACTIVE', settlement_method: 'CASH' }],
      }, // $50,000, paid $5,000 (10%)
      auditLogs: [
        {
          id: 2,
          deal_id: 1003,
          action: AUDIT_ACTION_SALES_SOURCE,
          changes_json: {
            old_source: SALES_SOURCES.UNSPECIFIED,
            new_source: SALES_SOURCES.MARKETER,
            new_partner_id: 501,
            marketer_name: 'Алишер',
          },
          created_at: '2026-11-06T10:00:00Z',
        },
        {
          id: 3,
          deal_id: 1003,
          action: AUDIT_ACTION_COMMISSION,
          changes_json: {
            action_type: 'APPROVE',
            approved_amount_minor: 150000, // $1,500
            status: COMMISSION_STATUSES.APPROVED,
          },
          created_at: '2026-11-07T10:00:00Z',
        },
        {
          id: 4,
          deal_id: 1003,
          action: AUDIT_ACTION_COMMISSION,
          changes_json: {
            action_type: 'RECORD_PAYOUT',
            paid_amount_minor: 50000, // $500
            status: COMMISSION_STATUSES.PARTIALLY_PAID,
          },
          created_at: '2026-11-08T10:00:00Z',
        },
      ],
      partnersMap,
    });
    expect(marketerAttr.salesSource).toBe(SALES_SOURCES.MARKETER);
    expect(marketerAttr.marketingPartnerName).toBe('Agency Alpha');
    expect(marketerAttr.marketerName).toBe('Алишер');
    expect(marketerAttr.commission.commissionRatePercent).toBe(3);
    expect(marketerAttr.commission.calculatedCommissionUsd).toBe(1500);
    expect(marketerAttr.commission.approvedCommissionUsd).toBe(1500);
    expect(marketerAttr.commission.paidCommissionUsd).toBe(500);
    expect(marketerAttr.commission.remainingCommissionUsd).toBe(1000);
    expect(marketerAttr.commission.status).toBe(COMMISSION_STATUSES.PARTIALLY_PAID);

    // 9d. Marketer sale with Partner #502 (no agreed rate) -> 0 USD, NOT_CALCULATED (never invents a rate!)
    const noRateAttr = resolveDealAttributionAndCommission({
      deal: { id: 1004, status: 'SIGNED', final_price_minor: 4500000 },
      auditLogs: [
        {
          id: 5,
          deal_id: 1004,
          action: AUDIT_ACTION_SALES_SOURCE,
          changes_json: { new_source: SALES_SOURCES.MARKETER, new_partner_id: 502 },
          created_at: '2026-11-06T12:00:00Z',
        },
      ],
      partnersMap,
    });
    expect(noRateAttr.salesSource).toBe(SALES_SOURCES.MARKETER);
    expect(noRateAttr.commission.calculatedCommissionUsd).toBe(0);
    expect(noRateAttr.commission.status).toBe(COMMISSION_STATUSES.NOT_CALCULATED);
  });

  it('10. [V3] Расторжение договора (CANCELLED): отмена невыплаченной комиссии, сохранение выплаченной в истории и независимый источник при перепродаже квартиры', () => {
    const partnersMap = new Map([
      [501, { id: 501, name: 'Agency Alpha', isActive: true, commissionType: 'PERCENT', commissionRateBp: 400, commissionRatePercent: 4 }]
    ]);

    // Terminated deal where $2,000 was approved and $600 was already paid before termination
    const terminatedAttr = resolveDealAttributionAndCommission({
      deal: {
        id: 2001,
        unit_id: 777,
        status: 'CANCELLED',
        cancelled_at: '2026-11-12T10:00:00Z',
        cancellation_reason: 'Расторжение по соглашению сторон',
        final_price_minor: 5000000, // $50,000
      },
      auditLogs: [
        {
          id: 10,
          deal_id: 2001,
          action: AUDIT_ACTION_SALES_SOURCE,
          changes_json: { new_source: SALES_SOURCES.MARKETER, new_partner_id: 501 },
          created_at: '2026-11-01T10:00:00Z',
        },
        {
          id: 11,
          deal_id: 2001,
          action: AUDIT_ACTION_COMMISSION,
          changes_json: {
            approved_amount_minor: 200000,
            paid_amount_minor: 60000,
            status: COMMISSION_STATUSES.PARTIALLY_PAID,
          },
          created_at: '2026-11-05T10:00:00Z',
        },
      ],
      partnersMap,
    });

    // Unpaid commission ($1,400) is cancelled; remaining to pay = 0; paid ($600) is preserved!
    expect(terminatedAttr.commission.status).toBe(COMMISSION_STATUSES.CANCELLED);
    expect(terminatedAttr.commission.paidCommissionUsd).toBe(600);
    expect(terminatedAttr.commission.remainingCommissionUsd).toBe(0);

    // New deal on the same apartment (unit_id = 777) starts fresh without inheriting old marketer attribution
    const resoldDealAttr = resolveDealAttributionAndCommission({
      deal: { id: 2002, unit_id: 777, status: 'SIGNED', final_price_minor: 5200000 },
      auditLogs: [], // new deal has its own empty log
      partnersMap,
    });
    expect(resoldDealAttr.salesSource).toBe(SALES_SOURCES.UNSPECIFIED);
    expect(resoldDealAttr.marketingPartnerId).toBeNull();
    expect(resoldDealAttr.commission.calculatedCommissionUsd).toBe(0);
  });

  it('11. [V3] RBAC и аудит при изменении источника продажи и управлении комиссией', async () => {
    const insertedAuditLogs = [];
    const mockDeal = {
      id: 3001,
      unit_id: 101,
      status: 'SIGNED',
      final_price_minor: 4000000, // $40,000
      payments: [{ id: 1, amount_minor: 400000, payment_date: '2026-11-05', status: 'ACTIVE', settlement_method: 'CASH' }], // 10% -> 3% = $1,200
    };
    const mockPartners = [
      {
        id: 501,
        type: 'MARKETING_PARTNER',
        name: 'Somon Marketing',
        is_active: true,
        code: JSON.stringify({
          contact_person: 'Фарход',
          phone: '+992927770011',
          commission_type: 'PERCENT',
          commission_rate_bp: 250, // 2.5%
        }),
      },
    ];

    const fakeDb = {
      from(table) {
        if (table === 'marketing_partners') {
          return {
            select: () => ({
              order: async () => ({ data: null, error: { message: 'table does not exist' } }),
              limit: async () => ({ data: null, error: { message: 'table does not exist' } }),
              eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'table does not exist' } }) }),
            }),
          };
        }
        if (table === 'dictionaries') {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  order: () => ({
                    eq: async () => ({ data: mockPartners, error: null }),
                    then: (resolve) => resolve({ data: mockPartners, error: null }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'users') {
          return {
            select: async () => ({
              data: [
                { id: 1, full_name: 'Admin User', role: 'ADMIN' },
                { id: 2, full_name: 'Sales Manager', role: 'SALES_MANAGER' },
              ],
              error: null,
            }),
          };
        }
        if (table === 'deals') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: mockDeal, error: null }),
              }),
            }),
          };
        }
        if (table === 'deal_audit_logs') {
          return {
            select: () => ({
              in: () => ({
                in: () => ({
                  order: async () => ({ data: insertedAuditLogs, error: null }),
                }),
              }),
            }),
            insert: async (row) => {
              const entry = {
                id: insertedAuditLogs.length + 1,
                ...row,
                created_at: new Date().toISOString(),
              };
              insertedAuditLogs.push(entry);
              return { data: entry, error: null };
            },
          };
        }
        return {};
      },
    };

    const service = new MarketingAttributionService(() => fakeDb);

    // 11a. Regular SALES_MANAGER cannot change source of a SIGNED contract
    await expect(
      service.updateDealSalesSource(
        3001,
        { salesSource: 'DIRECT', reason: 'Хочу поменять' },
        { id: 2, role: 'SALES_MANAGER' }
      )
    ).rejects.toThrow(/только администратор/i);

    // 11b. ADMIN cannot change source of a SIGNED contract without providing a reason
    await expect(
      service.updateDealSalesSource(
        3001,
        { salesSource: 'DIRECT', reason: '' },
        { id: 1, role: 'ADMIN' }
      )
    ).rejects.toThrow(/обязательно укажите причину/i);

    // 11c. Selecting MARKETER without marketingPartnerId fails validation
    await expect(
      service.updateDealSalesSource(
        3001,
        { salesSource: 'MARKETER', reason: 'Привлёк внешний партнёр' },
        { id: 1, role: 'ADMIN' }
      )
    ).rejects.toThrow(/необходимо выбрать маркетингового партнёра/i);

    // 11d. ADMIN sets MARKETER with partner 501 and valid reason -> logs audit & calculates 2.5% of $40,000 = $1,000
    const updatedDeal = await service.updateDealSalesSource(
      3001,
      {
        salesSource: 'MARKETER',
        marketingPartnerId: 501,
        marketerName: 'Фарход',
        reason: 'Подтверждён акт сверки с партнёром Somon Marketing',
      },
      { id: 1, role: 'ADMIN', fullName: 'Admin User' }
    );

    expect(updatedDeal.sales_source).toBe('MARKETER');
    expect(updatedDeal.marketing_partner_name).toBe('Somon Marketing');
    expect(updatedDeal.commission.calculatedCommissionUsd).toBe(1200);
    expect(updatedDeal.commission.status).toBe('CALCULATED');
    expect(updatedDeal.source_history).toHaveLength(1);
    expect(updatedDeal.source_history[0].oldSource).toBe('UNSPECIFIED');
    expect(updatedDeal.source_history[0].newSource).toBe('MARKETER');
    expect(updatedDeal.source_history[0].reason).toContain('Подтверждён акт сверки');

    // 11e. SALES_MANAGER cannot approve or pay commission
    await expect(
      service.updateDealCommission(
        3001,
        { action: 'APPROVE' },
        { id: 2, role: 'SALES_MANAGER' }
      )
    ).rejects.toThrow(/не может утверждать/i);

    // 11f. DIRECTOR can submit for approval, ADMIN can approve, FINANCE_MANAGER can record payout
    const afterSubmit = await service.updateDealCommission(
      3001,
      { action: 'SUBMIT_FOR_APPROVAL', notes: 'Проверено руководителем' },
      { id: 3, role: 'DIRECTOR' }
    );
    expect(afterSubmit.commission.status).toBe('PENDING_APPROVAL');

    const afterApprove = await service.updateDealCommission(
      3001,
      { action: 'APPROVE', notes: 'Утверждено к выплате' },
      { id: 1, role: 'ADMIN' }
    );
    expect(afterApprove.commission.status).toBe('APPROVED');
    expect(afterApprove.commission.approvedCommissionUsd).toBe(1200);
    expect(afterApprove.commission.remainingCommissionUsd).toBe(1200);

    const afterPayout = await service.updateDealCommission(
      3001,
      { action: 'RECORD_PAYOUT', payoutAmountUsd: 400, notes: 'Частичная выплата по РКО' },
      { id: 4, role: 'FINANCE_MANAGER' }
    );
    expect(afterPayout.commission.status).toBe('PARTIALLY_PAID');
    expect(afterPayout.commission.paidCommissionUsd).toBe(400);
    expect(afterPayout.commission.remainingCommissionUsd).toBe(800);
  });

  it('12. [V3] Фильтрация отчёта по источнику продажи (salesSource) и маркетинговому партнёру (partnerId)', () => {
    const partners = [
      {
        id: 701,
        name: 'Media Дом',
        isActive: true,
        commissionType: 'PERCENT',
        commissionRateBp: 300,
        commissionRatePercent: 3,
        commissionFixedMinor: 0,
      },
    ];

    const v3Deals = [
      makeDeal({
        id: 401,
        unitId: 501,
        unitNumber: '501',
        blockCode: 'А',
        projectName: 'TOZON PLAZA',
        dealDate: '2026-11-03',
        contractNumber: 'V3-DIR-1',
        finalPriceMinor: 4000000, // $40,000
      }),
      makeDeal({
        id: 402,
        unitId: 502,
        unitNumber: '502',
        blockCode: 'Б',
        projectName: 'TOZON PLAZA',
        dealDate: '2026-11-05',
        contractNumber: 'V3-MKT-1',
        finalPriceMinor: 5000000, // $50,000 -> 10% paid -> 3% = $1,500
        payments: [{ id: 1, amount_minor: 500000, payment_date: '2026-11-05', status: 'ACTIVE', settlement_method: 'CASH' }],
      }),
      makeDeal({
        id: 403,
        unitId: 503,
        unitNumber: '503',
        blockCode: 'В',
        projectName: 'TOZON PLAZA-2',
        dealDate: '2026-11-08',
        contractNumber: 'V3-UNSPEC-1',
        finalPriceMinor: 3000000, // $30,000
      }),
    ];

    const auditLogs = [
      {
        id: 1,
        deal_id: 401,
        action: AUDIT_ACTION_SALES_SOURCE,
        changes_json: { new_source: 'DIRECT' },
        created_at: '2026-11-03T12:00:00Z',
      },
      {
        id: 2,
        deal_id: 402,
        action: AUDIT_ACTION_SALES_SOURCE,
        changes_json: { new_source: 'MARKETER', new_partner_id: 701 },
        created_at: '2026-11-05T12:00:00Z',
      },
      {
        id: 3,
        deal_id: 402,
        action: AUDIT_ACTION_COMMISSION,
        changes_json: {
          approved_amount_minor: 150000,
          paid_amount_minor: 50000,
          status: 'PARTIALLY_PAID',
        },
        created_at: '2026-11-06T12:00:00Z',
      },
    ];

    // Full report (ALL sources)
    const fullReport = ApartmentSalesReportService.computeReport({
      deals: v3Deals,
      buildings: SAMPLE_BUILDINGS,
      marketingPartners: partners,
      dealAuditLogs: auditLogs,
      query: { startDate: '2026-11-01', endDate: '2026-11-13' },
      now: fixedNow,
    });

    expect(fullReport.summary.totalSoldCount).toBe(3);
    expect(fullReport.summary.directSoldCount).toBe(1);
    expect(fullReport.summary.marketerSoldCount).toBe(1);
    expect(fullReport.summary.unspecifiedSoldCount).toBe(1);
    expect(fullReport.summary.directSalesAmountUsd).toBe(40000);
    expect(fullReport.summary.marketerSalesAmountUsd).toBe(50000);
    expect(fullReport.summary.unspecifiedSalesAmountUsd).toBe(30000);
    expect(fullReport.summary.calculatedCommissionUsd).toBe(1500);
    expect(fullReport.summary.approvedCommissionUsd).toBe(1500);
    expect(fullReport.summary.paidCommissionUsd).toBe(500);
    expect(fullReport.summary.remainingCommissionUsd).toBe(1000);

    // Filter by DIRECT only
    const directOnly = ApartmentSalesReportService.computeReport({
      deals: v3Deals,
      buildings: SAMPLE_BUILDINGS,
      marketingPartners: partners,
      dealAuditLogs: auditLogs,
      query: { startDate: '2026-11-01', endDate: '2026-11-13', salesSource: 'DIRECT' },
      now: fixedNow,
    });
    expect(directOnly.summary.totalSoldCount).toBe(1);
    expect(directOnly.apartments[0].contractNumber).toBe('V3-DIR-1');
    expect(directOnly.summary.calculatedCommissionUsd).toBe(0);

    // Filter by partnerId = 701
    const partnerOnly = ApartmentSalesReportService.computeReport({
      deals: v3Deals,
      buildings: SAMPLE_BUILDINGS,
      marketingPartners: partners,
      dealAuditLogs: auditLogs,
      query: { startDate: '2026-11-01', endDate: '2026-11-13', partnerId: '701' },
      now: fixedNow,
    });
    expect(partnerOnly.summary.totalSoldCount).toBe(1);
    expect(partnerOnly.apartments[0].contractNumber).toBe('V3-MKT-1');
    expect(partnerOnly.apartments[0].marketingPartnerName).toBe('Media Дом');
  });

  it('13. [V3 Audit] Защита от авто-начисления по неподписанным сделкам, двойного начисления, повторной выплаты и потери данных при переходе на таблицы 055', async () => {
    const partnersMap = new Map([
      [
        801,
        {
          id: 801,
          name: 'Partner Alpha',
          isActive: true,
          commissionType: 'PERCENT',
          commissionRateBp: 300,
          commissionRatePercent: 3,
          commissionFixedMinor: 0,
        },
      ],
    ]);

    // 13a. RESERVED deal (not SIGNED yet) must NOT accrue commission even with MARKETER source
    const reservedAttr = resolveDealAttributionAndCommission({
      deal: { id: 8001, status: 'RESERVED', final_price_minor: 5000000 },
      auditLogs: [
        {
          id: 1,
          deal_id: 8001,
          action: AUDIT_ACTION_SALES_SOURCE,
          changes_json: { new_source: 'MARKETER', new_partner_id: 801 },
          created_at: '2026-11-10T10:00:00Z',
        },
      ],
      partnersMap,
    });
    expect(reservedAttr.salesSource).toBe('MARKETER');
    expect(reservedAttr.commission.status).toBe(COMMISSION_STATUSES.NOT_CALCULATED);
    expect(reservedAttr.commission.calculatedCommissionUsd).toBe(0);
    expect(reservedAttr.commission.approvedCommissionUsd).toBe(0);

    // 13b. Service-level guards against double accrual, double approval, duplicate payout, and source change after payout
    const state = {
      deal: {
        id: 8002,
        status: 'SIGNED',
        final_price_minor: 10000000, // $100,000
        payments: [{ id: 1, amount_minor: 1000000, payment_date: '2026-11-10', status: 'ACTIVE', settlement_method: 'CASH' }], // 10% -> 3% = $3,000
      },
      logs: [
        {
          id: 1,
          deal_id: 8002,
          user_id: 1,
          action: AUDIT_ACTION_SALES_SOURCE,
          changes_json: { new_source: 'MARKETER', new_partner_id: 801 },
          created_at: '2026-11-10T10:00:00Z',
        },
      ],
      dedicatedPartners: [
        {
          id: 801,
          name: 'Partner Alpha',
          is_active: true,
          commission_type: 'PERCENT',
          commission_rate_bp: 300,
          commission_fixed_minor: 0,
        },
      ],
      dictPartners: [
        {
          id: 802,
          type: 'MARKETING_PARTNER',
          name: 'Hybrid Partner Beta',
          is_active: true,
          code: JSON.stringify({ commissionType: 'NONE', commissionRateBp: 0 }),
        },
      ],
    };

    const mockDb = {
      from: (table) => {
        if (table === 'deals') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: state.deal, error: null }),
              }),
            }),
            update: (vals) => ({
              eq: async () => {
                Object.assign(state.deal, vals);
                return { data: state.deal, error: null };
              },
            }),
          };
        }
        if (table === 'marketing_partners') {
          return {
            select: () => ({
              order: async () => ({ data: state.dedicatedPartners, error: null }),
            }),
          };
        }
        if (table === 'dictionaries') {
          const q = {
            eq: () => q,
            order: () => q,
            then: (resolve) => resolve({ data: state.dictPartners, error: null }),
          };
          return { select: () => q };
        }
        if (table === 'users') {
          return {
            select: async () => ({ data: [{ id: 1, name: 'Admin User', role: 'ADMIN' }], error: null }),
          };
        }
        if (table === 'deal_audit_logs') {
          const q = {
            in: () => q,
            order: async () => ({ data: state.logs, error: null }),
          };
          return {
            select: () => q,
            insert: async (row) => {
              state.logs.push({
                id: state.logs.length + 1,
                ...row,
                created_at: new Date().toISOString(),
              });
              return { error: null };
            },
          };
        }
        return {
          insert: async () => ({ error: null }),
          update: () => ({ eq: async () => ({ error: null }) }),
          upsert: async () => ({ error: null }),
        };
      },
    };

    const svc = new MarketingAttributionService(() => mockDb);
    const adminUser = { id: 1, role: 'ADMIN', fullName: 'Admin User' };

    // Verify hybrid + dedicated partner merge (zero loss)
    const mergedPartners = await svc.getMarketingPartners({ includeInactive: true, user: adminUser });
    expect(mergedPartners.map((p) => p.id).sort()).toEqual([801, 802]);

    // First approval succeeds ($3,000)
    const approvedDeal = await svc.updateDealCommission(8002, { action: 'APPROVE' }, adminUser);
    expect(approvedDeal.commission.status).toBe(COMMISSION_STATUSES.APPROVED);
    expect(approvedDeal.commission.approvedCommissionUsd).toBe(3000);

    // Double approval is blocked
    await expect(
      svc.updateDealCommission(8002, { action: 'APPROVE' }, adminUser)
    ).rejects.toThrow(/уже утверждена/);

    // Double accrual (SET_RATE after approval) is blocked
    await expect(
      svc.updateDealCommission(8002, { action: 'SET_RATE', commissionType: 'PERCENT', commissionRatePercent: 5 }, adminUser)
    ).rejects.toThrow(/Повторное начисление запрещено/);

    // First payout of $1,500 with idempotencyKey succeeds
    const partialDeal = await svc.updateDealCommission(
      8002,
      { action: 'RECORD_PAYOUT', payoutAmountUsd: 1500, idempotencyKey: 'payout-8002-1' },
      adminUser
    );
    expect(partialDeal.commission.status).toBe(COMMISSION_STATUSES.PARTIALLY_PAID);
    expect(partialDeal.commission.paidCommissionUsd).toBe(1500);

    // Duplicate payout with same idempotencyKey is blocked
    await expect(
      svc.updateDealCommission(
        8002,
        { action: 'RECORD_PAYOUT', payoutAmountUsd: 1500, idempotencyKey: 'payout-8002-1' },
        adminUser
      )
    ).rejects.toThrow(/идемпотентности/);

    // Changing source to DIRECT after commission payout is blocked
    await expect(
      svc.updateDealSalesSource(
        8002,
        { salesSource: 'DIRECT', reason: 'Попытка сменить источник после выплаты' },
        adminUser
      )
    ).rejects.toThrow(/уже выплачена комиссия/);

    // Pay remaining $1,500 -> PAID
    const paidDeal = await svc.updateDealCommission(
      8002,
      { action: 'RECORD_PAYOUT', payoutAmountUsd: 1500, idempotencyKey: 'payout-8002-2' },
      adminUser
    );
    expect(paidDeal.commission.status).toBe(COMMISSION_STATUSES.PAID);
    expect(paidDeal.commission.remainingCommissionUsd).toBe(0);

    // Any further payout after PAID is blocked
    await expect(
      svc.updateDealCommission(
        8002,
        { action: 'RECORD_PAYOUT', payoutAmountUsd: 100 },
        adminUser
      )
    ).rejects.toThrow(/уже полностью выплачена/);
  });
});

describe('ApartmentSalesReportService - Per-block & Totals Source Breakdown with Paid Down Payment', () => {
  it('computes DIRECT, MARKETER, UNSPECIFIED sub-rows and confirmed paid down payment without trusting unpaid down_payment_minor', async () => {
    const buildings = [
      makeBuilding({ id: 1, name: 'Блок А', code: 'БЛОК-А', projectId: 1, projectName: 'ЖК Тозон', projectCode: 'TZN' }),
    ];
    const units = [
      makeUnit({ id: 901, unitNumber: '1', areaX100: 5000, floorNumber: 1, buildingId: 1, buildingName: 'Блок А', buildingCode: 'БЛОК-А', projectId: 1, projectName: 'ЖК Тозон', projectCode: 'TZN', status: 'SOLD' }),
      makeUnit({ id: 902, unitNumber: '2', areaX100: 6000, floorNumber: 2, buildingId: 1, buildingName: 'Блок А', buildingCode: 'БЛОК-А', projectId: 1, projectName: 'ЖК Тозон', projectCode: 'TZN', status: 'SOLD' }),
      makeUnit({ id: 903, unitNumber: '3', areaX100: 7000, floorNumber: 3, buildingId: 1, buildingName: 'Блок А', buildingCode: 'БЛОК-А', projectId: 1, projectName: 'ЖК Тозон', projectCode: 'TZN', status: 'SOLD' }),
    ];
    const deals = [
      // 1. DIRECT: $40,000 contract, $10,000 down payment declared, $10,000 confirmed cash paid + $2,000 voided (excluded) + $5,000 future (excluded)
      {
        ...makeDeal({
          id: 9101,
          unitId: 901,
          unitNumber: '1',
          buildingId: 1,
          buildingName: 'Блок А',
          buildingCode: 'БЛОК-А',
          projectId: 1,
          projectName: 'ЖК Тозон',
          projectCode: 'TZN',
          dealDate: '2026-09-01',
          signedAt: '2026-09-01T10:00:00Z',
          contractNumber: '9101',
          finalPriceMinor: 4000000,
          downPaymentMinor: 1000000,
          payments: [
            { id: 1, amount_minor: 1000000, payment_date: '2026-09-01', status: 'ACTIVE', settlement_method: 'CASH' },
            { id: 2, amount_minor: 200000, payment_date: '2026-09-02', status: 'VOIDED', settlement_method: 'CASH' },
            { id: 3, amount_minor: 500000, payment_date: '2026-12-31', status: 'ACTIVE', settlement_method: 'CASH' },
          ],
        }),
        sales_source: 'DIRECT',
      },
      // 2. MARKETER: $50,000 contract, $15,000 down payment declared, $15,000 barter paid (barter_amount_minor with 0 barter rows -> no double count)
      {
        ...makeDeal({
          id: 9102,
          unitId: 902,
          unitNumber: '2',
          buildingId: 1,
          buildingName: 'Блок А',
          buildingCode: 'БЛОК-А',
          projectId: 1,
          projectName: 'ЖК Тозон',
          projectCode: 'TZN',
          dealDate: '2026-10-15',
          signedAt: '2026-10-15T10:00:00Z',
          contractNumber: '9102',
          finalPriceMinor: 5000000,
          downPaymentMinor: 1500000,
          barterAmountMinor: 1500000,
          paymentType: 'PARTIAL_BARTER',
          payments: [],
        }),
        sales_source: 'MARKETER',
        marketing_partner_id: 50,
        marketing_partners: { id: 50, name: 'Партнёр 1', is_active: true, commission_type: 'PERCENT', commission_rate_bp: 300 },
      },
      // 3. UNSPECIFIED: $30,000 contract, $10,000 down payment declared, ZERO actual payments (like contract 0016 -> paidDownPayment must be 0!)
      {
        ...makeDeal({
          id: 9103,
          unitId: 903,
          unitNumber: '3',
          buildingId: 1,
          buildingName: 'Блок А',
          buildingCode: 'БЛОК-А',
          projectId: 1,
          projectName: 'ЖК Тозон',
          projectCode: 'TZN',
          dealDate: '2026-10-20',
          signedAt: '2026-10-20T10:00:00Z',
          contractNumber: '9103',
          finalPriceMinor: 3000000,
          downPaymentMinor: 1000000,
          payments: [],
        }),
        sales_source: 'UNSPECIFIED',
      },
    ];

    const report = ApartmentSalesReportService.computeReport({
      deals,
      buildings,
      units,
      query: { startDate: '2026-01-01', endDate: '2026-11-30', complex: 'ALL', block: 'ALL', salesSource: 'ALL', partnerId: 'ALL' },
      now: new Date('2026-11-14T10:00:00Z'),
    });

    const blockA = report.blocks.find((b) => b.soldCount > 0);
    expect(blockA).toBeDefined();
    expect(blockA.soldCount).toBe(3);
    expect(blockA.salesAmountUsd).toBe(120000);
    expect(blockA.paidDownPaymentUsd).toBe(25000); // 10k + 15k + 0 (NOT 35k!)
    expect(blockA.paidDownPaymentPercent).toBe(20.83); // 25000 / 120000 * 100

    const directSub = blockA.sourceBreakdown.find((s) => s.salesSource === 'DIRECT');
    const marketerSub = blockA.sourceBreakdown.find((s) => s.salesSource === 'MARKETER');
    const unspecifiedSub = blockA.sourceBreakdown.find((s) => s.salesSource === 'UNSPECIFIED');

    expect(directSub).toMatchObject({ soldCount: 1, salesAmountUsd: 40000, paidDownPaymentUsd: 10000, paidDownPaymentPercent: 25 });
    expect(marketerSub).toMatchObject({ soldCount: 1, salesAmountUsd: 50000, paidDownPaymentUsd: 15000, paidDownPaymentPercent: 30 });
    expect(unspecifiedSub).toMatchObject({ soldCount: 1, salesAmountUsd: 30000, paidDownPaymentUsd: 0, paidDownPaymentPercent: 0 });

    // Totals match sum of categories
    expect(report.totals.sourceBreakdown).toEqual(blockA.sourceBreakdown);

    // Excel export includes sub-rows and down payment columns
    const buffer = await ApartmentSalesReportService.generateExcelWorkbook(report.filters, null, null, report);
    expect(buffer).toBeDefined();
    expect(buffer.byteLength).toBeGreaterThan(1000);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const summarySheet = wb.getWorksheet('Сводный отчёт');
    const sheetTexts = [];
    summarySheet.eachRow((r) => sheetTexts.push(r.values.filter(Boolean).map(String).join(' | ')));
    expect(sheetTexts.some((t) => t.includes('Прямая продажа TOZON'))).toBe(true);
    expect(sheetTexts.some((t) => t.includes('Продажа через маркетологов'))).toBe(true);
    expect(sheetTexts.some((t) => t.includes('Источник не определён'))).toBe(true);
    expect(sheetTexts.some((t) => t.includes('ИТОГО') && t.includes('Прямая продажа TOZON'))).toBe(true);
  });
});

describe('Individual Per-Contract Tiered Marketer Commission Scale (0% / 2% / 3% / 4%)', () => {
  it('applies exact integer threshold comparisons without intermediate float rounding', () => {
    const price = 4000000; // $40,000.00
    expect(computeTieredCommissionRateBp(0, price)).toBe(0);
    expect(computeTieredCommissionRateBp(199999, price)).toBe(0); // 4.999975% (< 5%) -> 0%
    expect(computeTieredCommissionRateBp(200000, price)).toBe(200); // 5.00% -> 2%
    expect(computeTieredCommissionRateBp(399999, price)).toBe(200); // 9.999975% (< 10%) -> 2%
    expect(computeTieredCommissionRateBp(400000, price)).toBe(300); // 10.00% -> 3%
    expect(computeTieredCommissionRateBp(600000, price)).toBe(300); // 15.00% (<= 15%) -> 3%
    expect(computeTieredCommissionRateBp(600001, price)).toBe(400); // > 15% -> 4%
  });

  it('tracks incremental accruals 2% -> 3% -> 4% ($800 -> +$400 -> +$400) without duplicate payouts, and handles overpayment safely', async () => {
    const state = {
      deal: {
        id: 9501,
        status: 'SIGNED',
        final_price_minor: 4000000, // $40,000
        sales_source: 'MARKETER',
        marketing_partner_id: 1,
        payments: [{ id: 1, amount_minor: 200000, payment_date: '2026-10-15', status: 'ACTIVE', settlement_method: 'CASH' }], // 5% -> $800 (2%)
      },
      logs: [],
      partners: [{ id: 1, name: 'Партнёр 1', is_active: true, commission_type: 'NONE', commission_rate_bp: 0 }],
    };

    let nextLogId = 1;
    const mockDb = {
      from: (table) => {
        if (table === 'deals') {
          return {
            select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.deal, error: null }) }) }),
            update: (vals) => ({ eq: async () => { Object.assign(state.deal, vals); return { data: state.deal, error: null }; } }),
          };
        }
        if (table === 'marketing_partners') {
          const mpChain = {
            eq: () => mpChain,
            order: async () => ({ data: state.partners, error: null }),
          };
          return { select: () => mpChain };
        }
        if (table === 'dictionaries') {
          const dictChain = {
            eq: () => dictChain,
            order: () => dictChain,
            then: (resolve) => resolve({ data: [], error: null }),
          };
          return { select: () => dictChain };
        }
        if (table === 'deal_audit_logs') {
          const makeChain = () => ({
            eq: () => makeChain(),
            in: () => makeChain(),
            order: async () => ({ data: state.logs, error: null }),
          });
          return {
            select: () => makeChain(),
            insert: async (row) => {
              state.logs.push({ id: nextLogId++, created_at: new Date().toISOString(), ...row });
              return { error: null };
            },
          };
        }
        if (table === 'users') {
          return { select: () => ({ in: async () => ({ data: [{ id: 1, name: 'Admin' }], error: null }) }) };
        }
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }), order: async () => ({ data: [], error: null }) }),
          upsert: async () => ({ error: null }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      },
    };

    const svc = new MarketingAttributionService(() => mockDb);
    const admin = { id: 1, role: 'ADMIN', fullName: 'Admin' };

    // Stage 1: 5% paid ($2,000) -> 2% ($800) -> approve & pay $800
    await svc.updateDealCommission(9501, { action: 'APPROVE' }, admin);
    const paid1 = await svc.updateDealCommission(9501, { action: 'RECORD_PAYOUT', payoutAmountUsd: 800 }, admin);
    expect(paid1.commission.commissionRatePercent).toBe(2);
    expect(paid1.commission.calculatedCommissionUsd).toBe(800);
    expect(paid1.commission.paidCommissionUsd).toBe(800);
    expect(paid1.commission.remainingCommissionUsd).toBe(0);

    // Stage 2: Client pays another $2,000 -> total $4,000 (10%) -> 3% ($1,200), delta = +$400 ONLY
    state.deal.payments.push({ id: 2, amount_minor: 200000, payment_date: '2026-10-20', status: 'ACTIVE', settlement_method: 'CASH' });
    const stage2 = await svc.enrichDealWithAttribution(state.deal, admin);
    expect(stage2.commission.commissionRatePercent).toBe(3);
    expect(stage2.commission.calculatedCommissionUsd).toBe(1200);
    expect(stage2.commission.approvedCommissionUsd).toBe(800);
    expect(stage2.commission.additionalAccrualUsd).toBe(400);
    expect(stage2.commission.status).toBe(COMMISSION_STATUSES.CALCULATED);

    const approved2 = await svc.updateDealCommission(9501, { action: 'APPROVE' }, admin);
    expect(approved2.commission.approvedCommissionUsd).toBe(1200);
    expect(approved2.commission.remainingCommissionUsd).toBe(400);
    const paid2 = await svc.updateDealCommission(9501, { action: 'RECORD_PAYOUT', payoutAmountUsd: 400 }, admin);
    expect(paid2.commission.paidCommissionUsd).toBe(1200);
    expect(paid2.commission.remainingCommissionUsd).toBe(0);

    // Stage 3: Client pays another $2,001 -> total $6,001 (>15%) -> 4% ($1,600), delta = +$400 ONLY
    state.deal.payments.push({ id: 3, amount_minor: 200100, payment_date: '2026-10-25', status: 'ACTIVE', settlement_method: 'CASH' });
    const approved3 = await svc.updateDealCommission(9501, { action: 'APPROVE' }, admin);
    expect(approved3.commission.commissionRatePercent).toBe(4);
    expect(approved3.commission.calculatedCommissionUsd).toBe(1600);
    expect(approved3.commission.remainingCommissionUsd).toBe(400);

    // Stage 4: Refund / void reduces settled amount back to $1,000 (2.5% -> 0% commission) while $1,200 already paid
    state.deal.payments = [{ id: 1, amount_minor: 100000, payment_date: '2026-10-15', status: 'ACTIVE', settlement_method: 'CASH' }];
    const overpaidDeal = await svc.enrichDealWithAttribution(state.deal, admin);
    expect(overpaidDeal.commission.commissionRatePercent).toBe(0);
    expect(overpaidDeal.commission.calculatedCommissionUsd).toBe(0);
    expect(overpaidDeal.commission.paidCommissionUsd).toBe(1200);
    expect(overpaidDeal.commission.remainingCommissionUsd).toBe(0);
    expect(overpaidDeal.commission.overpaidCommissionUsd).toBe(1200);

    await expect(
      svc.updateDealCommission(9501, { action: 'RECORD_PAYOUT', payoutAmountUsd: 100 }, admin)
    ).rejects.toThrow(/переплата/i);
  });

  it('aggregates block commission as sum of individual deal commissions rather than block-level payment %', () => {
    const buildings = [
      makeBuilding({ id: 1, name: 'Блок А', code: 'БЛОК-А', projectId: 1, projectName: 'TOZON PLAZA', projectCode: 'TZN' }),
    ];
    const units = [
      makeUnit({ id: 951, unitNumber: '1', areaX100: 5000, floorNumber: 1, buildingId: 1, buildingName: 'Блок А', buildingCode: 'БЛОК-А', projectId: 1, projectName: 'TOZON PLAZA', projectCode: 'TZN', status: 'SOLD' }),
      makeUnit({ id: 952, unitNumber: '2', areaX100: 5000, floorNumber: 1, buildingId: 1, buildingName: 'Блок А', buildingCode: 'БЛОК-А', projectId: 1, projectName: 'TOZON PLAZA', projectCode: 'TZN', status: 'SOLD' }),
    ];
    // Deal 1: $50,000, paid $1,000 (2% < 5% -> 0% commission = $0)
    // Deal 2: $50,000, paid $10,000 (20% > 15% -> 4% commission = $2,000)
    // Block aggregate payment % = $11,000 / $100,000 = 11% (which would be 3% = $3,000 if mistakenly computed at block level!)
    // Correct sum of individual commissions = $0 + $2,000 = $2,000!
    const deals = [
      {
        ...makeDeal({
          id: 9601,
          unitId: 951,
          unitNumber: '1',
          buildingId: 1,
          buildingName: 'Блок А',
          buildingCode: 'БЛОК-А',
          projectId: 1,
          projectName: 'TOZON PLAZA',
          projectCode: 'TZN',
          dealDate: '2026-10-15',
          finalPriceMinor: 5000000,
          payments: [{ id: 1, amount_minor: 100000, payment_date: '2026-10-15', status: 'ACTIVE', settlement_method: 'CASH' }],
        }),
        sales_source: 'MARKETER',
        marketing_partner_id: 1,
      },
      {
        ...makeDeal({
          id: 9602,
          unitId: 952,
          unitNumber: '2',
          buildingId: 1,
          buildingName: 'Блок А',
          buildingCode: 'БЛОК-А',
          projectId: 1,
          projectName: 'TOZON PLAZA',
          projectCode: 'TZN',
          dealDate: '2026-10-16',
          finalPriceMinor: 5000000,
          payments: [{ id: 2, amount_minor: 1000000, payment_date: '2026-10-16', status: 'ACTIVE', settlement_method: 'CASH' }],
        }),
        sales_source: 'MARKETER',
        marketing_partner_id: 1,
      },
    ];

    const report = ApartmentSalesReportService.computeReport({
      deals,
      buildings,
      units,
      marketingPartners: [{ id: 1, name: 'Партнёр 1', is_active: true, commission_type: 'NONE', commission_rate_bp: 0 }],
      query: { startDate: '2026-01-01', endDate: '2026-11-30', complex: 'ALL', block: 'ALL', salesSource: 'ALL', partnerId: 'ALL' },
      now: new Date('2026-11-14T10:00:00Z'),
    });

    const blockA = report.blocks.find((b) => b.soldCount > 0);
    expect(blockA.calculatedCommissionUsd).toBe(2000);
    expect(report.totals.calculatedCommissionUsd).toBe(2000);
  });
});
