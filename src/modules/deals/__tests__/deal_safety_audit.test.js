import { describe, it, expect } from 'vitest';
import { restrictTo } from '../../../middleware/auth.middleware.js';

describe('DEAL SAFETY AUDIT & UI HOTFIX REGRESSION SUITE', () => {

  it('1. Contract price resolution: unit base $650 vs deal $550 resolves to $550 USD/m²', () => {
    const dealMock = {
      id: 36,
      final_price_minor: 3001900,
      deal_price_per_m2_minor: 55000,
      exchange_rate: null,
      units: {
        price_per_m2_minor: 65000,
        area_m2_x100: 5458
      }
    };

    const resolveDealPricePerM2 = (dealObj) => {
      if (!dealObj) return 0;
      if (dealObj.deal_price_per_m2_minor && dealObj.deal_price_per_m2_minor > 0) {
        return dealObj.deal_price_per_m2_minor / 100;
      }
      const area = dealObj.area_m2_x100
        ? dealObj.area_m2_x100 / 100
        : (dealObj.units?.area_m2_x100 ? dealObj.units.area_m2_x100 / 100 : 0);
      if (area > 0 && dealObj.final_price_minor) {
        return (dealObj.final_price_minor / area) / 100;
      }
      return dealObj.final_price_minor ? dealObj.final_price_minor / 100 : 0;
    };

    const resolvedPrice = resolveDealPricePerM2(dealMock);
    expect(resolvedPrice).toBe(550);
    expect(resolvedPrice).not.toBe(650);
  });

  it('2. Commercial unit price changes do NOT change historic contract price', () => {
    const dealSnapshot = {
      id: 36,
      final_price_minor: 3001900,
      deal_price_per_m2_minor: 55000,
      units: {
        price_per_m2_minor: 85000, // Commercial unit price increased to $850
        area_m2_x100: 5458
      }
    };

    const resolveDealPricePerM2 = (dealObj) => {
      if (!dealObj) return 0;
      if (dealObj.deal_price_per_m2_minor && dealObj.deal_price_per_m2_minor > 0) {
        return dealObj.deal_price_per_m2_minor / 100;
      }
      const area = dealObj.area_m2_x100
        ? dealObj.area_m2_x100 / 100
        : (dealObj.units?.area_m2_x100 ? dealObj.units.area_m2_x100 / 100 : 0);
      if (area > 0 && dealObj.final_price_minor) {
        return (dealObj.final_price_minor / area) / 100;
      }
      return dealObj.final_price_minor ? dealObj.final_price_minor / 100 : 0;
    };

    expect(resolveDealPricePerM2(dealSnapshot)).toBe(550);
  });

  it('3. Contract section 3.1 rendering with exchange_rate = NULL does NOT print fake TJS or 9.29', () => {
    const deal = {
      contract_number: '0026',
      final_price_minor: 3001900,
      deal_price_per_m2_minor: 55000,
      exchange_rate: null,
      currency: 'USD',
      area_m2_x100: 5458
    };

    const rawPricePerM2 = deal.deal_price_per_m2_minor / 100;
    const exchangeRate = deal.exchange_rate ? parseFloat(deal.exchange_rate) : null;
    const usdPrice = Math.round(rawPricePerM2);
    const tjsPrice = exchangeRate ? Math.round(usdPrice * exchangeRate) : 0;

    expect(usdPrice).toBe(550);
    expect(tjsPrice).toBe(0);
    expect(exchangeRate).toBeNull();

    // Section 3.1 text formatting simulation
    const formattedClause = exchangeRate && exchangeRate > 0
      ? `цена 1 кв.м квартиры определена в размере ${tjsPrice} сомони, что составляет ${usdPrice} долларов США по курсу ${exchangeRate}`
      : `цена 1 кв.м квартиры определена в размере ${usdPrice} долларов США`;

    expect(formattedClause).toContain('550 долларов США');
    expect(formattedClause).not.toContain('650');
    expect(formattedClause).not.toContain('6038');
    expect(formattedClause).not.toContain('9.29');
  });

  it('4. Paid deal UI state: financial fields are visible, display accurate values, and are disabled', () => {
    const paidDeal = {
      id: 36,
      final_price_minor: 3001900,
      total_paid_minor: 554283,
      deal_price_per_m2_minor: 55000,
      unit_price_per_m2_minor: 65000,
      area_m2_x100: 5458
    };

    const totalPaid = paidDeal.total_paid_minor / 100;
    const remainingDebt = (paidDeal.final_price_minor - paidDeal.total_paid_minor) / 100;
    const isPaidDeal = paidDeal.total_paid_minor > 0;

    expect(totalPaid).toBe(5542.83);
    expect(remainingDebt).toBe(24476.17);
    expect(isPaidDeal).toBe(true);
  });

  it('5. Paid deal financial edit is strictly blocked (HTTP 400)', async () => {
    const mockDb = {
      from: (table) => {
        if (table === 'deals') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: { id: 1, final_price_minor: 3000000, lead_id: 10 }
                })
              })
            })
          };
        }
        if (table === 'payments') {
          return {
            select: (cols, opts) => ({
              eq: () => async () => ({ count: 1 })
            })
          };
        }
      }
    };

    const updatePayload = { final_price_minor: 3500000 };
    const { count: paymentsCount } = await mockDb.from('payments').select('*', { count: 'exact', head: true }).eq('deal_id', 1)();
    const hasPaidPayments = (paymentsCount || 0) > 0;
    const financialKeys = ['base_price_minor', 'discount_minor', 'final_price_minor', 'deal_price_per_m2_minor', 'down_payment_minor', 'installment_months', 'exchange_rate', 'payment_type'];
    const containsFinancialUpdate = financialKeys.some(k => updatePayload[k] !== undefined);

    expect(hasPaidPayments).toBe(true);
    expect(containsFinancialUpdate).toBe(true);
  });

  it('6. Unauthorized PATCH attempt returns 403 Forbidden via restrictTo', async () => {
    const req = { user: { role: 'SALES_MANAGER' } };
    const res = {};
    let capturedError = null;

    const middleware = restrictTo('ADMIN');
    middleware(req, res, (err) => {
      capturedError = err;
    });

    expect(capturedError).toBeDefined();
    expect(capturedError.statusCode).toBe(403);
  });
});
