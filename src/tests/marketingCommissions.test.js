import { describe, it, expect, vi, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { authorizeSectionRequest } from '../middleware/sectionAccess.js';
import { ApartmentSalesReportService } from '../modules/reports/apartmentSalesReport.service.js';
import { MarketingCommissionsService } from '../modules/finance/marketingCommissions.service.js';
import {
  AUDIT_ACTION_COMMISSION,
  AUDIT_ACTION_SALES_SOURCE,
  MarketingAttributionService,
} from '../modules/reports/marketingAttribution.service.js';

const users = {
  ADMIN: { id: 1, role: 'ADMIN', name: 'Admin', permissions: ['access.v2', 'finance.view', 'finance.view.write', 'finance.expenses', 'finance.expenses.write', 'deals.view'] },
  DIRECTOR: { id: 2, role: 'DIRECTOR', name: 'Director', permissions: ['access.v2', 'finance.view', 'deals.view', 'analytics.reports'] },
  FINANCE_MANAGER: { id: 3, role: 'FINANCE_MANAGER', name: 'Fin', permissions: ['access.v2', 'finance.view', 'finance.expenses', 'finance.expenses.write', 'deals.view'] },
  SALES_MANAGER: { id: 4, role: 'SALES_MANAGER', name: 'Sales', permissions: ['access.v2', 'deals.view', 'contracts.view'] },
  WAREHOUSE_MANAGER: { id: 5, role: 'WAREHOUSE_MANAGER', name: 'WH', permissions: ['access.v2', 'construction.stock', 'finance.expenses'] },
  CASHIER: { id: 6, role: 'CASHIER', name: 'Cashier', permissions: ['access.v2'] },
};

function makeReq(method, originalUrl, user) {
  return { method, originalUrl, user, body: {}, query: {} };
}

function createInMemoryCommissionDb({ deal, rkoRows = [] }) {
  const auditLogs = [];
  let nextLogId = 100;

  return {
    auditLogs,
    from(table) {
      const state = { filters: [] };
      const chain = {
        select() { return chain; },
        eq(col, val) { state.filters.push({ op: 'eq', col, val }); return chain; },
        in(col, vals) { state.filters.push({ op: 'in', col, vals }); return chain; },
        order() { return chain; },
        limit() { return chain; },
        async maybeSingle() {
          if (table === 'deals') {
            const idFilter = state.filters.find((f) => f.col === 'id');
            if (!idFilter || Number(idFilter.val) !== Number(deal.id)) return { data: null, error: null };
            return { data: deal, error: null };
          }
          if (table === 'expenses') {
            const idFilter = state.filters.find((f) => f.col === 'id');
            const found = rkoRows.find((r) => Number(r.id) === Number(idFilter?.val));
            return { data: found || null, error: null };
          }
          return { data: null, error: null };
        },
        async insert(row) {
          if (table === 'deal_audit_logs') {
            const inserted = {
              id: nextLogId++,
              ...row,
              created_at: new Date().toISOString(),
            };
            auditLogs.push(inserted);
            return { data: [inserted], error: null };
          }
          return { data: [row], error: null };
        },
        async upsert() {
          return { data: null, error: null };
        },
        async update() {
          return { data: null, error: null };
        },
        then(resolve) {
          if (table === 'deal_audit_logs') {
            return Promise.resolve({ data: [...auditLogs], error: null }).then(resolve);
          }
          if (table === 'marketing_partners') {
            return Promise.resolve({
              data: [{ id: 701, name: 'Somon Agency', is_active: true, commission_type: 'PERCENT', commission_rate_bp: 300 }],
              error: null,
            }).then(resolve);
          }
          if (table === 'dictionaries') {
            return Promise.resolve({ data: [], error: null }).then(resolve);
          }
          if (table === 'users') {
            return Promise.resolve({
              data: [
                { id: 1, name: 'Admin', role: 'ADMIN' },
                { id: 3, name: 'Fin', role: 'FINANCE_MANAGER' },
              ],
              error: null,
            }).then(resolve);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve);
        },
      };
      return chain;
    },
  };
}

describe('Marketing Commissions Registry (Backend)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('enforces RBAC on /api/finance/marketing-commissions endpoints', async () => {
    for (const role of ['ADMIN', 'DIRECTOR', 'FINANCE_MANAGER', 'SALES_MANAGER']) {
      await expect(
        authorizeSectionRequest(makeReq('GET', '/api/finance/marketing-commissions', users[role]))
      ).resolves.toBeUndefined();
    }

    for (const role of ['WAREHOUSE_MANAGER', 'CASHIER']) {
      await expect(
        authorizeSectionRequest(makeReq('GET', '/api/finance/marketing-commissions', users[role]))
      ).rejects.toMatchObject({ statusCode: 403 });
    }

    for (const role of ['DIRECTOR', 'SALES_MANAGER', 'WAREHOUSE_MANAGER', 'CASHIER']) {
      await expect(
        authorizeSectionRequest(makeReq('POST', '/api/finance/marketing-commissions/10/approve', users[role]))
      ).rejects.toMatchObject({ statusCode: 403 });
    }

    await expect(
      authorizeSectionRequest(makeReq('POST', '/api/finance/marketing-commissions/10/payout', users.FINANCE_MANAGER))
    ).resolves.toBeUndefined();
  });

  it('aggregates MARKETER deals, filters, partner summary, totals, and Excel export accurately', async () => {
    const mockApartments = [
      {
        dealId: 101,
        contractNumber: 'ДГ-101',
        contractDate: '2026-08-10',
        projectName: 'TOZON PLAZA',
        blockCode: 'А',
        unitNumber: '12',
        floorNumber: 3,
        areaM2: 65,
        buyerName: 'Иванов И.И.',
        salesSource: 'MARKETER',
        marketingPartnerId: 701,
        marketingPartnerName: 'Agency Alpha',
        contractPriceMinor: 10000000, // 100,000 USD
        contractPriceUsd: 100000,
        totalSettledMinor: 2000000, // 20,000 USD (20% -> 4%)
        totalSettledUsd: 20000,
        paymentPercent: 20,
        commissionRateBp: 400,
        commissionRatePercent: 4,
        calculatedCommissionMinor: 400000,
        calculatedCommissionUsd: 4000,
        approvedCommissionMinor: 300000,
        approvedCommissionUsd: 3000,
        paidCommissionMinor: 300000,
        paidCommissionUsd: 3000,
        remainingCommissionMinor: 0,
        remainingCommissionUsd: 0,
        additionalAccrualMinor: 100000,
        additionalAccrualUsd: 1000,
        overpaidCommissionMinor: 0,
        overpaidCommissionUsd: 0,
        commissionStatus: 'CALCULATED',
        commissionStatusLabel: 'Рассчитана',
      },
      {
        dealId: 102,
        contractNumber: 'ДГ-102',
        contractDate: '2026-09-01',
        projectName: 'TOZON PLAZA-2',
        blockCode: 'Б',
        unitNumber: '25',
        floorNumber: 5,
        areaM2: 50,
        buyerName: 'Петров П.П.',
        salesSource: 'MARKETER',
        marketingPartnerId: 702,
        marketingPartnerName: 'Agency Beta',
        contractPriceMinor: 5000000, // 50,000 USD
        contractPriceUsd: 50000,
        totalSettledMinor: 200000, // 2,000 USD (4% -> 0%)
        totalSettledUsd: 2000,
        paymentPercent: 4,
        commissionRateBp: 0,
        commissionRatePercent: 0,
        calculatedCommissionMinor: 0,
        calculatedCommissionUsd: 0,
        approvedCommissionMinor: 0,
        approvedCommissionUsd: 0,
        paidCommissionMinor: 0,
        paidCommissionUsd: 0,
        remainingCommissionMinor: 0,
        remainingCommissionUsd: 0,
        additionalAccrualMinor: 0,
        additionalAccrualUsd: 0,
        overpaidCommissionMinor: 0,
        overpaidCommissionUsd: 0,
        commissionStatus: 'NOT_CALCULATED',
        commissionStatusLabel: 'Не рассчитана',
      },
      {
        dealId: 103,
        contractNumber: 'ДГ-103',
        contractDate: '2026-09-05',
        projectName: 'TOZON PLAZA',
        blockCode: 'В',
        unitNumber: '7',
        floorNumber: 2,
        areaM2: 40,
        buyerName: 'Сидоров С.С.',
        salesSource: 'DIRECT',
        contractPriceMinor: 4000000,
        contractPriceUsd: 40000,
        calculatedCommissionUsd: 0,
      },
    ];

    vi.spyOn(ApartmentSalesReportService, 'getApartmentSalesReport').mockResolvedValue({
      apartments: mockApartments,
      marketingPartners: [
        { id: 701, name: 'Agency Alpha' },
        { id: 702, name: 'Agency Beta' },
      ],
    });
    vi.spyOn(MarketingCommissionsService, 'loadRkoLinksByDealId').mockResolvedValue(new Map());

    const registry = await MarketingCommissionsService.getRegistry({}, users.DIRECTOR);
    expect(registry.rows).toHaveLength(2);
    expect(registry.totals.contractPriceUsd).toBe(150000);
    expect(registry.totals.totalSettledUsd).toBe(22000);
    expect(registry.totals.calculatedCommissionUsd).toBe(4000);
    expect(registry.totals.approvedCommissionUsd).toBe(3000);
    expect(registry.totals.paidCommissionUsd).toBe(3000);
    expect(registry.totals.additionalAccrualUsd).toBe(1000);
    expect(registry.totals.rateBreakdown).toEqual({ '0': 1, '2': 0, '3': 0, '4': 1 });
    expect(registry.partnerSummary).toHaveLength(2);
    expect(registry.permissions).toMatchObject({
      role: 'DIRECTOR',
      canView: true,
      canApprove: false,
      canPayout: false,
      canCancel: false,
      canExport: true,
    });

    // Test rate filter & search filter
    const filtered = await MarketingCommissionsService.getRegistry({ rate: '4', search: 'Иванов' }, users.ADMIN);
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.rows[0].dealId).toBe(101);

    // Test Excel export
    const xlsxBuf = await MarketingCommissionsService.exportWorkbook({}, users.DIRECTOR);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsxBuf);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Реестр комиссий', 'Сводка по партнёрам']);
    await expect(MarketingCommissionsService.exportWorkbook({}, users.SALES_MANAGER)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('prevents concurrent double-approval, enforces incremental approval, RKO linkage, and blocks payouts on refund overpayment', async () => {
    const deal = {
      id: 555,
      status: 'SIGNED',
      final_price_minor: 10000000, // 100,000 USD
      sales_source: 'MARKETER',
      marketing_partner_id: 701,
      payments: [
        { id: 1, amount_minor: 1200000, status: 'ACTIVE', settlement_method: 'CASH' }, // 12% -> 3% = 3,000 USD
      ],
    };

    const mockDb = createInMemoryCommissionDb({
      deal,
      rkoRows: [{ id: 88, reference: 'РКО-88', recipient: 'Somon Agency', amount_minor: 300000, status: 'ACTIVE', voided_at: null }],
    });
    const service = new MarketingAttributionService(() => mockDb);

    // Concurrent APPROVE requests on the same deal: exactly 1 succeeds, 1 fails
    const [r1, r2] = await Promise.allSettled([
      service.updateDealCommission(555, { action: 'APPROVE', idempotencyKey: 'app-1' }, users.ADMIN),
      service.updateDealCommission(555, { action: 'APPROVE', idempotencyKey: 'app-2' }, users.ADMIN),
    ]);
    expect([r1.status, r2.status].sort()).toEqual(['fulfilled', 'rejected']);

    // FINANCE_MANAGER cannot APPROVE
    await expect(
      service.updateDealCommission(555, { action: 'APPROVE', idempotencyKey: 'app-fin' }, users.FINANCE_MANAGER)
    ).rejects.toMatchObject({ statusCode: 403 });

    // FINANCE_MANAGER records payout with RKO link
    const afterPayout = await service.updateDealCommission(
      555,
      { action: 'RECORD_PAYOUT', payoutAmountUsd: 3000, rkoExpenseId: 88, idempotencyKey: 'pay-1' },
      users.FINANCE_MANAGER
    );
    expect(afterPayout.commission.paidCommissionUsd).toBe(3000);
    expect(afterPayout.commission.status).toBe('PAID');
    expect(afterPayout.commission_history[0].rkoReference).toBe('РКО-88');

    // Replay with SAME idempotencyKey and SAME params -> idempotent: true without duplicate payout
    const replayedPayout = await service.updateDealCommission(
      555,
      { action: 'RECORD_PAYOUT', payoutAmountUsd: 3000, rkoExpenseId: 88, idempotencyKey: 'pay-1' },
      users.FINANCE_MANAGER
    );
    expect(replayedPayout.idempotent).toBe(true);
    expect(replayedPayout.commission.paidCommissionUsd).toBe(3000);

    // Replay with SAME idempotencyKey but DIFFERENT amount -> 409 IDEMPOTENCY_CONFLICT
    await expect(
      service.updateDealCommission(
        555,
        { action: 'RECORD_PAYOUT', payoutAmountUsd: 100, idempotencyKey: 'pay-1' },
        users.FINANCE_MANAGER
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' });

    // Buyer pays more -> reaches 20% (>15% -> 4% = 4,000 USD). Only difference (1,000 USD) needs approval!
    deal.payments.push({ id: 2, amount_minor: 800000, status: 'ACTIVE', settlement_method: 'CASH' });
    const upgraded = await service.updateDealCommission(
      555,
      { action: 'APPROVE', idempotencyKey: 'app-upgrade' },
      users.ADMIN
    );
    expect(upgraded.commission.commissionRatePercent).toBe(4);
    expect(upgraded.commission.calculatedCommissionUsd).toBe(4000);
    expect(upgraded.commission.approvedCommissionUsd).toBe(4000);
    expect(upgraded.commission.paidCommissionUsd).toBe(3000);
    expect(upgraded.commission.remainingCommissionUsd).toBe(1000);
    expect(upgraded.commission_history[0].additionalAccrualUsd).toBe(1000);

    // Refund drops settled amount below 5% -> 0% calculated -> overpaid = 3,000 USD -> new payouts blocked!
    deal.refund_amount_minor = 1700000; // net settled = 3,000 USD (3% < 5%)
    await expect(
      service.updateDealCommission(
        555,
        { action: 'RECORD_PAYOUT', payoutAmountUsd: 100, idempotencyKey: 'pay-over' },
        users.FINANCE_MANAGER
      )
    ).rejects.toMatchObject({ code: 'COMMISSION_OVERPAID', statusCode: 400 });
  });

  it('blocks real payouts via MarketingCommissionsService until atomic PostgreSQL RKO integration (migration 057) is applied', async () => {
    vi.spyOn(MarketingCommissionsService, 'isAtomicRkoIntegrationReady').mockResolvedValue(false);

    await expect(
      MarketingCommissionsService.payoutDealCommission(
        101,
        { payoutAmountUsd: 500, rkoExpenseId: 88, idempotencyKey: 'pay-blocked-1' },
        users.FINANCE_MANAGER
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'ATOMIC_RKO_INTEGRATION_REQUIRED' });
  });

  it('preserves RKO links marked RECONCILIATION_REQUIRED and excludes legacy RKO_VOIDED_REVERSAL in loadRkoLinksByDealId', async () => {
    const mockDb = createInMemoryCommissionDb({ deal: { id: 101 } });
    mockDb.auditLogs.push(
      {
        id: 1,
        deal_id: 101,
        action: AUDIT_ACTION_COMMISSION,
        created_at: '2026-11-14T10:00:00Z',
        changes_json: { action_type: 'RECORD_PAYOUT', rko_expense_id: 10, rko_reference: 'РКО-10', payout_delta_minor: 300000 },
      },
      {
        id: 2,
        deal_id: 101,
        action: AUDIT_ACTION_COMMISSION,
        created_at: '2026-11-14T10:05:00Z',
        changes_json: { action_type: 'RKO_VOIDED_RECONCILIATION_REQUIRED', rko_expense_id: 10, rko_reference: 'РКО-10' },
      },
      {
        id: 3,
        deal_id: 101,
        action: AUDIT_ACTION_COMMISSION,
        created_at: '2026-11-14T10:10:00Z',
        changes_json: { action_type: 'RECORD_PAYOUT', rko_expense_id: 14, rko_reference: 'РКО-14', payout_delta_minor: 300000 },
      }
    );
    const linksMap = await MarketingCommissionsService.loadRkoLinksByDealId([101], mockDb);
    const links = linksMap.get(101) || [];
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ rkoExpenseId: 10, reconciliationStatus: 'RECONCILIATION_REQUIRED' });
    expect(links[1]).toMatchObject({ rkoExpenseId: 14, reconciliationStatus: 'OK' });

    await expect(
      MarketingCommissionsService.confirmPayoutRefund(
        101,
        { payoutOperationId: 1, refundAmountUsd: 3000, refundDocumentRef: 'ПКО-1', reason: 'Возврат', idempotencyKey: 'ref-1' },
        users.FINANCE_MANAGER
      )
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(
      MarketingCommissionsService.reconcilePayoutWithNewRko(
        101,
        { payoutOperationId: 1, newRkoExpenseId: 14, reason: 'Замена РКО', idempotencyKey: 'rec-1' },
        users.FINANCE_MANAGER
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
