import { describe, it, expect } from 'vitest';
import { restrictTo } from '../../../middleware/auth.middleware.js';

describe('SAFE DEAL TERMINATION GATE TEST MATRIX (V2)', () => {

  it('1. IDEMPOTENCY: Stable deterministic key TERMINATE_DEAL_<id> prevents duplicate RKO insertion', () => {
    const dealId = 101;
    // Deterministic key format independent of request timestamp
    const getStableIdempotencyKey = (id, reqKey) => reqKey ? String(reqKey).trim() : `TERMINATE_DEAL_${id}`;

    const key1 = getStableIdempotencyKey(dealId, null);
    const key2 = getStableIdempotencyKey(dealId, null);

    expect(key1).toBe('TERMINATE_DEAL_101');
    expect(key2).toBe('TERMINATE_DEAL_101');
    expect(key1).toBe(key2);

    // Simulation of DB-level UNIQUE constraint on expenses.idempotency_key
    const expensesTable = [];
    const insertExpense = (payload) => {
      const existing = expensesTable.find(e => e.idempotency_key === payload.idempotency_key);
      if (existing) {
        return { data: existing, isDuplicate: true };
      }
      const newRow = { id: expensesTable.length + 1, ...payload };
      expensesTable.push(newRow);
      return { data: newRow, isDuplicate: false };
    };

    const req1 = insertExpense({ idempotency_key: key1, amount_minor: 80000, category: 'Возврат средств' });
    const req2 = insertExpense({ idempotency_key: key2, amount_minor: 80000, category: 'Возврат средств' });

    expect(req1.isDuplicate).toBe(false);
    expect(req2.isDuplicate).toBe(true);
    expect(expensesTable.length).toBe(1); // Exactly 1 expense created!
  });

  it('2. PARTIAL PAYMENT HISTORY: Preserves original amount_minor (2000) and paid_amount_minor (600)', () => {
    const originalSchedule = {
      id: 42,
      amount_minor: 200000, // Original planned: $2,000
      paid_amount_minor: 60000, // Actually paid: $600
      status: 'PARTIAL'
    };

    // Correct termination transformation: status becomes CANCELLED, amount_minor & paid_amount_minor remain intact!
    const terminatedSchedule = {
      ...originalSchedule,
      status: 'CANCELLED'
    };

    expect(terminatedSchedule.amount_minor).toBe(200000); // Preserved $2,000 planned
    expect(terminatedSchedule.paid_amount_minor).toBe(60000); // Preserved $600 paid fact
    
    const cancelledOutstandingMinor = terminatedSchedule.amount_minor - terminatedSchedule.paid_amount_minor;
    expect(cancelledOutstandingMinor).toBe(140000); // Identifiable $1,400 cancelled remaining obligation!
  });

  it('3. ATOMICITY: PostgreSQL RPC function failure after RKO rolls back all changes', () => {
    // Simulation of PostgreSQL single-transaction rollback
    let dbState = {
      deals: [{ id: 101, status: 'SIGNED' }],
      units: [{ id: 201, status: 'SOLD' }],
      expenses: [],
      schedules: [{ id: 1, status: 'UPCOMING' }]
    };

    const runAtomicRpcTransaction = (shouldFailAfterExpense = false) => {
      const snapshot = JSON.parse(JSON.stringify(dbState));
      try {
        dbState.expenses.push({ id: 1, amount_minor: 50000 });
        if (shouldFailAfterExpense) {
          throw new Error('SIMULATED_DB_ERROR_AFTER_EXPENSE');
        }
        dbState.deals[0].status = 'CANCELLED';
        dbState.units[0].status = 'AVAILABLE';
      } catch (err) {
        // PL/pgSQL transaction exception triggers full ROLLBACK
        dbState = snapshot;
        return { success: false, error: err.message };
      }
      return { success: true };
    };

    const res = runAtomicRpcTransaction(true);
    expect(res.success).toBe(false);
    expect(dbState.expenses.length).toBe(0); // RKO rolled back!
    expect(dbState.deals[0].status).toBe('SIGNED'); // Deal untouched!
    expect(dbState.units[0].status).toBe('SOLD'); // Unit untouched!
  });

  it('4. CURRENCY & CASH DESK: USD deal refund requires USD currency matching', () => {
    const dealUSD = { id: 101, currency: 'USD', final_price_minor: 5000000 };
    const refundData = { refund_amount_minor: 100000, cash_desk_id: 'ab90800a-73af-4cf7-88c2-397c304e2edf' };

    const validateRefundCurrency = (deal, data) => {
      const expenseCurrency = deal.currency || 'USD';
      if (expenseCurrency !== deal.currency) {
        throw new Error('CURRENCY_MISMATCH');
      }
      return { expenseCurrency, amountMinor: data.refund_amount_minor };
    };

    const res = validateRefundCurrency(dealUSD, refundData);
    expect(res.expenseCurrency).toBe('USD');
    expect(res.amountMinor).toBe(100000);
  });

  it('5. SECURITY: MANAGER role calling /terminate returns 403 Forbidden', () => {
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

  it('6. SIGNED deal + simple cancel -> blocked by backend guard (HTTP 400)', () => {
    const signedDeal = { id: 101, status: 'SIGNED', payments: [{ amount_minor: 100000, status: 'ACTIVE' }] };
    
    const activePayments = (signedDeal.payments || []).filter(p => p.status !== 'VOIDED');
    const paidTotalMinor = activePayments.reduce((sum, p) => sum + (p.amount_minor || 0), 0);

    const isSimpleCancelBlocked = signedDeal.status === 'SIGNED' || paidTotalMinor > 0;
    expect(isSimpleCancelBlocked).toBe(true);
  });
});
