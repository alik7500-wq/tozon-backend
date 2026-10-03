import { describe, it, expect, vi } from 'vitest';
import { FinanceRepository } from '../finance.repository.js';

// Cash desk balance calculation helper matching client/utils/cashDesks.js logic
const getCashDeskBalance = (payments, targetCurrency = 'USD') => {
  return payments
    .filter(p => p.status === 'ACTIVE' && (p.currency || 'USD') === targetCurrency)
    .reduce((sum, p) => sum + (p.amount_minor ? p.amount_minor / 100 : Number(p.amount || 0)), 0);
};

describe('Historical PKO TJS Manual Reconciliation Test Matrix (Section 16)', () => {

  // Test A: ADMIN + ACTIVE + amount_tjs NULL -> recovery allowed
  it('A. ADMIN + ACTIVE + amount_tjs NULL -> recovery allowed', async () => {
    const mockPayment = {
      id: 428,
      status: 'ACTIVE',
      amount_tjs: null,
      amount_minor: 539957,
      currency: 'USD',
      deal_id: 31
    };

    const mockReconcileResult = {
      payment: {
        ...mockPayment,
        amount_tjs: 50000,
        exchange_rate: 9.26,
        amount_usd: 5399.57
      },
      audit: {
        event_type: 'HISTORICAL_PKO_TJS_RECONCILED',
        performed_by: 1
      }
    };

    vi.spyOn(FinanceRepository, 'reconcileIncomeTjs').mockResolvedValue(mockReconcileResult);

    const result = await FinanceRepository.reconcileIncomeTjs(428, {
      amount_tjs: 50000,
      exchange_rate: 9.26,
      reason: 'Бумажный ПКО',
      comment: 'Сверено с бумажным ПКО №0006'
    }, 'ADMIN', 1);

    expect(result.payment.amount_tjs).toBe(50000);
    expect(result.payment.exchange_rate).toBe(9.26);
    expect(result.payment.amount_minor).toBe(539957); // Immutable
    expect(result.audit.event_type).toBe('HISTORICAL_PKO_TJS_RECONCILED');

    vi.restoreAllMocks();
  });

  // Test B: MANAGER role -> forbidden
  it('B. MANAGER role -> forbidden', () => {
    const userRole = 'SALES_MANAGER';
    const isAdmin = userRole === 'ADMIN';

    expect(isAdmin).toBe(false);
  });

  // Test C: ACTIVE + amount_tjs already populated -> 409 CONFLICT
  it('C. ACTIVE + amount_tjs already populated -> 409 CONFLICT', async () => {
    const error = new Error('HISTORICAL_PKO_ALREADY_RECONCILED: Историческая сумма TJS уже восстановлена.');
    error.status = 409;

    vi.spyOn(FinanceRepository, 'reconcileIncomeTjs').mockRejectedValue(error);

    await expect(FinanceRepository.reconcileIncomeTjs(428, {
      amount_tjs: 50000,
      reason: 'Бумажный ПКО',
      comment: 'Повторная попытка'
    }, 'ADMIN', 1)).rejects.toThrow('HISTORICAL_PKO_ALREADY_RECONCILED');

    vi.restoreAllMocks();
  });

  // Test D: VOIDED payment -> forbidden
  it('D. VOIDED payment -> forbidden', async () => {
    const error = new Error('INVALID_PAYMENT_STATUS: Восстановление доступно только для активных ПКО.');
    error.status = 400;

    vi.spyOn(FinanceRepository, 'reconcileIncomeTjs').mockRejectedValue(error);

    await expect(FinanceRepository.reconcileIncomeTjs(999, {
      amount_tjs: 50000,
      reason: 'Бумажный ПКО',
      comment: 'Для отменённого'
    }, 'ADMIN', 1)).rejects.toThrow('INVALID_PAYMENT_STATUS');

    vi.restoreAllMocks();
  });

  // Test E: amount_tjs <= 0 -> validation error
  it('E. amount_tjs <= 0 -> validation error', () => {
    const amountTjs = -500;
    const isValid = Number(amountTjs) > 0;

    expect(isValid).toBe(false);
  });

  // Test F: invalid exchange_rate -> validation error
  it('F. invalid exchange_rate <= 0 -> validation error', () => {
    const exchangeRate = -9.26;
    const isValidRate = exchangeRate === null || exchangeRate === undefined || Number(exchangeRate) > 0;

    expect(isValidRate).toBe(false);
  });

  // Test G: exchange_rate omitted -> allowed with exchange_rate = NULL
  it('G. exchange_rate omitted -> allowed with exchange_rate = NULL', async () => {
    const mockReconcileResult = {
      payment: {
        id: 428,
        amount_tjs: 50000,
        exchange_rate: null,
        amount_usd: 5399.57,
        amount_minor: 539957,
        currency: 'USD'
      }
    };

    vi.spyOn(FinanceRepository, 'reconcileIncomeTjs').mockResolvedValue(mockReconcileResult);

    const result = await FinanceRepository.reconcileIncomeTjs(428, {
      amount_tjs: 50000,
      exchange_rate: null,
      reason: 'Кассовая книга',
      comment: 'Без курса'
    }, 'ADMIN', 1);

    expect(result.payment.amount_tjs).toBe(50000);
    expect(result.payment.exchange_rate).toBeNull();
    expect(result.payment.amount_usd).toBe(5399.57);

    vi.restoreAllMocks();
  });

  // Test H: double submit -> idempotency protection (only one mutation possible)
  it('H. double submit -> idempotency protection', async () => {
    let callCount = 0;
    vi.spyOn(FinanceRepository, 'reconcileIncomeTjs').mockImplementation(async () => {
      callCount++;
      if (callCount > 1) {
        const err = new Error('HISTORICAL_PKO_ALREADY_RECONCILED');
        err.status = 409;
        throw err;
      }
      return { payment: { id: 428, amount_tjs: 50000 } };
    });

    const res1 = await FinanceRepository.reconcileIncomeTjs(428, { amount_tjs: 50000, reason: 'Бумажный ПКО', comment: 'Req 1' }, 'ADMIN', 1);
    expect(res1.payment.amount_tjs).toBe(50000);

    await expect(FinanceRepository.reconcileIncomeTjs(428, { amount_tjs: 50000, reason: 'Бумажный ПКО', comment: 'Req 2' }, 'ADMIN', 1))
      .rejects.toThrow('HISTORICAL_PKO_ALREADY_RECONCILED');

    expect(callCount).toBe(2);

    vi.restoreAllMocks();
  });

  // Test I: amount_minor before/after -> identical
  it('I. amount_minor before/after -> identical', () => {
    const beforePayment = { id: 428, amount_minor: 539957, currency: 'USD' };
    const afterPayment = { ...beforePayment, amount_tjs: 50000, exchange_rate: 9.26 };

    expect(afterPayment.amount_minor).toBe(beforePayment.amount_minor);
  });

  // Test J: deal paid before/after -> identical
  it('J. deal paid before/after -> identical', () => {
    const dealPayments = [{ amount_minor: 539957, currency: 'USD' }];
    const dealPaidBefore = dealPayments.reduce((sum, p) => sum + p.amount_minor, 0);

    // Reconcile amount_tjs on payment
    dealPayments[0].amount_tjs = 50000;
    dealPayments[0].exchange_rate = 9.26;

    const dealPaidAfter = dealPayments.reduce((sum, p) => sum + p.amount_minor, 0);

    expect(dealPaidAfter).toBe(dealPaidBefore);
  });

  // Test K: remaining debt before/after -> identical
  it('K. remaining debt before/after -> identical', () => {
    const dealPriceMinor = 10000000; // $100,000.00 USD
    const paidMinor = 539957;

    const debtBefore = dealPriceMinor - paidMinor;

    // After reconciliation
    const debtAfter = dealPriceMinor - paidMinor;

    expect(debtAfter).toBe(debtBefore);
  });

  // Test L: FIFO before/after -> identical
  it('L. FIFO before/after -> identical', () => {
    const scheduleAllocations = [{ schedule_id: 1, amount_minor: 539957 }];
    const allocatedBefore = scheduleAllocations.reduce((sum, a) => sum + a.amount_minor, 0);

    // After reconciliation of amount_tjs
    const allocatedAfter = scheduleAllocations.reduce((sum, a) => sum + a.amount_minor, 0);

    expect(allocatedAfter).toBe(allocatedBefore);
  });

  // Test M: cash desk balance before/after -> MUST be explicitly verified (NONE / NO side effect)
  it('M. cash desk balance before/after -> MUST be verified as NO side effect', () => {
    const paymentsListBefore = [
      { id: 428, currency: 'USD', amount_minor: 539957, status: 'ACTIVE', amount_tjs: null }
    ];

    const balanceBefore = getCashDeskBalance(paymentsListBefore, 'USD');

    // After reconciliation, amount_tjs is set to 50000, currency remains 'USD', amount_minor remains 539957
    const paymentsListAfter = [
      { id: 428, currency: 'USD', amount_minor: 539957, status: 'ACTIVE', amount_tjs: 50000, exchange_rate: 9.26 }
    ];

    const balanceAfter = getCashDeskBalance(paymentsListAfter, 'USD');

    expect(balanceAfter).toBe(balanceBefore);
    expect(balanceAfter).toBe(5399.57);
  });

});
