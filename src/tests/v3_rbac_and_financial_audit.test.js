import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authorizeSectionRequest } from '../middleware/sectionAccess.js';
import { marketingAttributionService } from '../modules/reports/marketingAttribution.service.js';

function makeUser(role, permissions = ['access.v2']) {
  return { id: 99, name: `Test ${role}`, role, permissions };
}

function makeMockReq(method, path, user) {
  return {
    method,
    originalUrl: path,
    query: {},
    user,
  };
}

describe('TOZON CRM V3 — Final RBAC Matrix & Financial Logic Audit', () => {
  describe('1. Section Access RBAC Matrix (ADMIN, DIRECTOR, FINANCE_MANAGER, SALES_MANAGER, WAREHOUSE_MANAGER)', () => {
    const users = {
      ADMIN: makeUser('ADMIN', ['access.v2', 'analytics.view', 'analytics.reports', 'deals.view', 'contracts.view', 'settings.view', 'finance.view', 'finance.payments']),
      DIRECTOR: makeUser('DIRECTOR', ['access.v2', 'analytics.view', 'analytics.reports', 'deals.view', 'contracts.view', 'finance.expenses', 'finance.debtors', 'finance.payments']),
      FINANCE_MANAGER: makeUser('FINANCE_MANAGER', ['access.v2', 'finance.restricted', 'analytics.view', 'analytics.reports', 'deals.view', 'contracts.view', 'finance.view', 'finance.payments', 'finance.expenses']),
      SALES_MANAGER: makeUser('SALES_MANAGER', ['access.v2', 'deals.view', 'deals.manage', 'contracts.view', 'finance.payments']),
      WAREHOUSE_MANAGER: makeUser('WAREHOUSE_MANAGER', ['access.v2', 'construction.stock', 'finance.expenses', 'finance.expenses.write']),
    };

    it('controls read access to /api/reports/apartment-sales across all 5 roles', async () => {
      for (const role of ['ADMIN', 'DIRECTOR', 'FINANCE_MANAGER', 'SALES_MANAGER']) {
        const req = makeMockReq('GET', '/api/reports/apartment-sales', users[role]);
        await expect(authorizeSectionRequest(req)).resolves.toBeUndefined();
      }
      const whReq = makeMockReq('GET', '/api/reports/apartment-sales', users.WAREHOUSE_MANAGER);
      await expect(authorizeSectionRequest(whReq)).rejects.toMatchObject({ statusCode: 403 });
    });

    it('blocks WAREHOUSE_MANAGER from reading /api/reports/marketing-partners and restricts writes to ADMIN only', async () => {
      for (const role of ['ADMIN', 'DIRECTOR', 'FINANCE_MANAGER', 'SALES_MANAGER']) {
        const req = makeMockReq('GET', '/api/reports/marketing-partners', users[role]);
        await expect(authorizeSectionRequest(req)).resolves.toBeUndefined();
      }
      const whRead = makeMockReq('GET', '/api/reports/marketing-partners', users.WAREHOUSE_MANAGER);
      await expect(authorizeSectionRequest(whRead)).rejects.toMatchObject({ statusCode: 403 });

      await expect(authorizeSectionRequest(makeMockReq('POST', '/api/reports/marketing-partners', users.ADMIN))).resolves.toBeUndefined();
      for (const role of ['DIRECTOR', 'FINANCE_MANAGER', 'SALES_MANAGER', 'WAREHOUSE_MANAGER']) {
        await expect(authorizeSectionRequest(makeMockReq('POST', '/api/reports/marketing-partners', users[role]))).rejects.toMatchObject({ statusCode: 403 });
      }
    });

    it('restricts /api/deals/:id/commission to ADMIN, DIRECTOR, FINANCE_MANAGER only', async () => {
      for (const role of ['ADMIN', 'DIRECTOR', 'FINANCE_MANAGER']) {
        await expect(authorizeSectionRequest(makeMockReq('PATCH', '/api/deals/10/commission', users[role]))).resolves.toBeUndefined();
      }
      for (const role of ['SALES_MANAGER', 'WAREHOUSE_MANAGER']) {
        await expect(authorizeSectionRequest(makeMockReq('PATCH', '/api/deals/10/commission', users[role]))).rejects.toMatchObject({ statusCode: 403 });
      }
    });
  });

  describe('2. Signed Deal Source Protection & Financial Commission Rules (Isolated Mock DB)', () => {
    let mockDeal;
    let mockLogs;
    let mockPartners;

    beforeEach(() => {
      mockDeal = {
        id: 500,
        contract_number: '0500',
        status: 'SIGNED',
        final_price_minor: 10000000, // $100,000.00
        sales_source: 'UNSPECIFIED',
        marketing_partner_id: null,
        marketer_name: null,
      };
      mockLogs = [];
      mockPartners = [
        {
          id: 7,
          name: 'Partner Alpha',
          is_active: true,
          commission_type: 'PERCENT',
          commission_rate_bp: 300, // 3%
          commission_fixed_minor: 0,
        },
      ];

      const mockDb = {
        from: (table) => {
          const state = { filters: {} };
          const chain = {
            select: () => chain,
            eq: (col, val) => {
              state.filters[col] = val;
              return chain;
            },
            in: () => chain,
            order: () => chain,
            limit: () => chain,
            maybeSingle: async () => {
              if (table === 'deals') return { data: mockDeal, error: null };
              return { data: null, error: null };
            },
            insert: async (payload) => {
              const row = Array.isArray(payload) ? payload[0] : payload;
              if (table === 'deal_audit_logs') {
                mockLogs.push({ id: mockLogs.length + 1, ...row, created_at: new Date().toISOString() });
              }
              return { data: row, error: null };
            },
            update: (patch) => ({
              eq: async () => {
                if (table === 'deals') Object.assign(mockDeal, patch);
                return { data: mockDeal, error: null };
              },
            }),
            upsert: async () => ({ data: null, error: null }),
            then: (resolve) => {
              if (table === 'marketing_partners') return resolve({ data: mockPartners, error: null });
              if (table === 'dictionaries') return resolve({ data: [], error: null });
              if (table === 'users') return resolve({ data: [{ id: 1, name: 'Admin', role: 'ADMIN' }], error: null });
              if (table === 'deal_audit_logs') return resolve({ data: mockLogs, error: null });
              return resolve({ data: [], error: null });
            },
          };
          return chain;
        },
      };

      vi.spyOn(marketingAttributionService, 'getDb').mockReturnValue(mockDb);
    });

    it('only ADMIN can change sales source of a SIGNED deal, and reason is mandatory', async () => {
      for (const role of ['DIRECTOR', 'SALES_MANAGER', 'FINANCE_MANAGER', 'WAREHOUSE_MANAGER']) {
        await expect(
          marketingAttributionService.updateDealSalesSource(
            500,
            { salesSource: 'DIRECT', reason: 'Уточнение' },
            { id: 2, role }
          )
        ).rejects.toMatchObject({ statusCode: 403 });
      }

      // ADMIN without reason -> 400 SOURCE_CHANGE_REASON_REQUIRED
      await expect(
        marketingAttributionService.updateDealSalesSource(
          500,
          { salesSource: 'DIRECT', reason: '' },
          { id: 1, role: 'ADMIN' }
        )
      ).rejects.toMatchObject({ statusCode: 400, code: 'SOURCE_CHANGE_REASON_REQUIRED' });

      // ADMIN with valid reason -> succeeds
      const res = await marketingAttributionService.updateDealSalesSource(
        500,
        { salesSource: 'DIRECT', reason: 'Подтверждена прямая продажа' },
        { id: 1, role: 'ADMIN' }
      );
      expect(res.sales_source).toBe('DIRECT');
      expect(res.commission.calculatedCommissionUsd).toBe(0);
    });

    it('forbids commission calculation on UNSPECIFIED or DIRECT sales (always 0)', async () => {
      // UNSPECIFIED
      await expect(
        marketingAttributionService.updateDealCommission(
          500,
          { action: 'SET_RATE', commissionType: 'PERCENT', commissionRatePercent: 3 },
          { id: 1, role: 'ADMIN' }
        )
      ).rejects.toMatchObject({ statusCode: 400, code: 'COMMISSION_NOT_ALLOWED_FOR_SOURCE' });

      // DIRECT
      await marketingAttributionService.updateDealSalesSource(
        500,
        { salesSource: 'DIRECT', reason: 'Прямая продажа' },
        { id: 1, role: 'ADMIN' }
      );
      await expect(
        marketingAttributionService.updateDealCommission(
          500,
          { action: 'SET_RATE', commissionType: 'PERCENT', commissionRatePercent: 3 },
          { id: 1, role: 'ADMIN' }
        )
      ).rejects.toMatchObject({ statusCode: 400, code: 'COMMISSION_NOT_ALLOWED_FOR_SOURCE' });
    });

    it('enforces approval before payout, agreed rate only, and role separation for MARKETER deals', async () => {
      await marketingAttributionService.updateDealSalesSource(
        500,
        { salesSource: 'MARKETER', marketingPartnerId: 7, marketerName: 'Али', reason: 'Договор с партнёром' },
        { id: 1, role: 'ADMIN' }
      );

      // Non-ADMIN cannot SET_RATE
      await expect(
        marketingAttributionService.updateDealCommission(
          500,
          { action: 'SET_RATE', commissionType: 'PERCENT', commissionRatePercent: 3 },
          { id: 2, role: 'DIRECTOR' }
        )
      ).rejects.toMatchObject({ statusCode: 403 });

      // ADMIN sets agreed rate 3% of $100,000 = $3,000
      const rated = await marketingAttributionService.updateDealCommission(
        500,
        { action: 'SET_RATE', commissionType: 'PERCENT', commissionRatePercent: 3 },
        { id: 1, role: 'ADMIN' }
      );
      expect(rated.commission.calculatedCommissionUsd).toBe(3000);
      expect(rated.commission.status).toBe('CALCULATED');

      // Payout BEFORE approval is strictly blocked
      await expect(
        marketingAttributionService.updateDealCommission(
          500,
          { action: 'RECORD_PAYOUT', payoutAmountUsd: 1000, idempotencyKey: 'pay-1' },
          { id: 4, role: 'FINANCE_MANAGER' }
        )
      ).rejects.toMatchObject({ statusCode: 400, code: 'COMMISSION_NOT_APPROVED' });

      // DIRECTOR submits for approval
      const submitted = await marketingAttributionService.updateDealCommission(
        500,
        { action: 'SUBMIT_FOR_APPROVAL' },
        { id: 2, role: 'DIRECTOR' }
      );
      expect(submitted.commission.status).toBe('PENDING_APPROVAL');

      // FINANCE_MANAGER cannot APPROVE
      await expect(
        marketingAttributionService.updateDealCommission(
          500,
          { action: 'APPROVE' },
          { id: 4, role: 'FINANCE_MANAGER' }
        )
      ).rejects.toMatchObject({ statusCode: 403 });

      // ADMIN approves
      const approved = await marketingAttributionService.updateDealCommission(
        500,
        { action: 'APPROVE' },
        { id: 1, role: 'ADMIN' }
      );
      expect(approved.commission.status).toBe('APPROVED');
      expect(approved.commission.approvedCommissionUsd).toBe(3000);

      // FINANCE_MANAGER records payout (after approval)
      const paid = await marketingAttributionService.updateDealCommission(
        500,
        { action: 'RECORD_PAYOUT', payoutAmountUsd: 1500, idempotencyKey: 'pay-1' },
        { id: 4, role: 'FINANCE_MANAGER' }
      );
      expect(paid.commission.paidCommissionUsd).toBe(1500);
      expect(paid.commission.status).toBe('PARTIALLY_PAID');

      // Replay with same idempotencyKey & same amount returns previous result without double payout
      const replayed = await marketingAttributionService.updateDealCommission(
        500,
        { action: 'RECORD_PAYOUT', payoutAmountUsd: 1500, idempotencyKey: 'pay-1' },
        { id: 4, role: 'FINANCE_MANAGER' }
      );
      expect(replayed.idempotent).toBe(true);
      expect(replayed.commission.paidCommissionUsd).toBe(1500);

      // Replay with same idempotencyKey & different amount blocked (409 IDEMPOTENCY_CONFLICT)
      await expect(
        marketingAttributionService.updateDealCommission(
          500,
          { action: 'RECORD_PAYOUT', payoutAmountUsd: 500, idempotencyKey: 'pay-1' },
          { id: 4, role: 'FINANCE_MANAGER' }
        )
      ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' });
    });
  });
});
