import { describe, it, expect, beforeAll } from 'vitest';
import { connectDB, getDB } from '../../../db/connection.js';
import { FinanceRepository } from '../finance.repository.js';

describe('Conversion Cash Desk Edit Regression & Amount Immutability Tests', () => {
  let db;

  beforeAll(async () => {
    await connectDB();
    db = getDB();
  });

  it('1. Expense #328 retains exact amount 554261 when patching only cash_desk_id', async () => {
    const { data: before } = await db.from('expenses').select('*').eq('id', 328).single();
    expect(before).toBeDefined();
    expect(before.amount_minor).toBe(554261);
    const originalDeskId = before.cash_desk_id;
    const testDeskId = 'ab90800a-73af-4cf7-88c2-397c304e2edf'; // Valid desk ID

    try {
      // Execute PATCH with only cash_desk_id
      await FinanceRepository.updateExpense(328, { cash_desk_id: testDeskId }, 'ADMIN', { isAdmin: true });

      const { data: after } = await db.from('expenses').select('*').eq('id', 328).single();
      expect(after.amount_minor).toBe(554261);
      expect(after.cash_desk_id).toBe(testDeskId);
    } finally {
      // Revert cash_desk_id back to original
      await FinanceRepository.updateExpense(328, { cash_desk_id: originalDeskId }, 'ADMIN', { isAdmin: true });
      const { data: reverted } = await db.from('expenses').select('*').eq('id', 328).single();
      expect(reverted.amount_minor).toBe(554261);
      expect(reverted.cash_desk_id).toBe(originalDeskId);
    }
  });

  it('2. Expense #338 retains exact amount 446386 when patching only cash_desk_id and does not take amount from #325', async () => {
    const { data: before } = await db.from('expenses').select('*').eq('id', 338).single();
    expect(before).toBeDefined();
    expect(before.amount_minor).toBe(446386);
    const originalDeskId = before.cash_desk_id;
    const testDeskId = 'ab90800a-73af-4cf7-88c2-397c304e2edf';

    try {
      await FinanceRepository.updateExpense(338, { cash_desk_id: testDeskId }, 'ADMIN', { isAdmin: true });

      const { data: after } = await db.from('expenses').select('*').eq('id', 338).single();
      expect(after.amount_minor).toBe(446386);
      expect(after.amount_minor).not.toBe(37756); // Must NEVER take amount from #325
      expect(after.cash_desk_id).toBe(testDeskId);
    } finally {
      await FinanceRepository.updateExpense(338, { cash_desk_id: originalDeskId }, 'ADMIN', { isAdmin: true });
      const { data: reverted } = await db.from('expenses').select('*').eq('id', 338).single();
      expect(reverted.amount_minor).toBe(446386);
      expect(reverted.cash_desk_id).toBe(originalDeskId);
    }
  });

  it('3. Updating payment #203 cash desk does NOT mutate #328 or #338 amounts', async () => {
    const { data: p203Before } = await db.from('payments').select('*').eq('id', 203).single();
    const { data: e328Before } = await db.from('expenses').select('*').eq('id', 328).single();
    const { data: e338Before } = await db.from('expenses').select('*').eq('id', 338).single();

    expect(p203Before.amount_minor).toBe(350000);
    expect(e328Before.amount_minor).toBe(554261);
    expect(e338Before.amount_minor).toBe(446386);

    const originalDeskId = p203Before.cash_desk_id;
    const testDeskId = 'ab90800a-73af-4cf7-88c2-397c304e2edf';

    try {
      // Update PKO #203 cash desk
      await FinanceRepository.updateIncome(203, { cash_desk_id: testDeskId }, 'ADMIN', { isAdmin: true });

      const { data: e328After } = await db.from('expenses').select('*').eq('id', 328).single();
      const { data: e338After } = await db.from('expenses').select('*').eq('id', 338).single();

      // Invariant: #328 and #338 must NOT be touched or corrupted
      expect(e328After.amount_minor).toBe(554261);
      expect(e338After.amount_minor).toBe(446386);
    } finally {
      await FinanceRepository.updateIncome(203, { cash_desk_id: originalDeskId }, 'ADMIN', { isAdmin: true });
    }
  });

  it('4. Attempting to change amount on a conversion document via standard update throws error', async () => {
    await expect(
      FinanceRepository.updateExpense(328, { amount: 100 }, 'ADMIN', { isAdmin: true })
    ).rejects.toThrow('Изменение суммы валютообменного ордера запрещено');

    await expect(
      FinanceRepository.updateIncome(203, { amount: 999 }, 'ADMIN', { isAdmin: true })
    ).rejects.toThrow('Изменение суммы валютообменного ордера запрещено');
  });
});
