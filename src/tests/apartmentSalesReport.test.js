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

  it('7. Генерация Excel (.xlsx) с 2 листами и всеми новыми финансовыми столбцами', async () => {
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
    expect(summarySheet.pageSetup.orientation).toBe('landscape');

    const detailsSheet = workbook.getWorksheet('Детализация квартир');
    expect(String(detailsSheet.getCell('A1').value)).toContain('ДЕТАЛИЗАЦИЯ ПРОДАННЫХ КВАРТИР');
    expect(detailsSheet.pageSetup.orientation).toBe('landscape');
    expect(detailsSheet.rowCount).toBe(9);
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
});
