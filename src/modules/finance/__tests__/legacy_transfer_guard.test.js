import { describe, it, expect, beforeAll } from 'vitest';
import { connectDB, getDB } from '../../../db/connection.js';
import { FinanceRepository } from '../finance.repository.js';

describe('Legacy Transfer Pair Void Guard Regression Test', () => {
  let db;

  beforeAll(async () => {
    await connectDB();
    db = getDB();
  });

  it('1. Throws error when attempting to void legacy transfer pair without a matching cash_transfers row', async () => {
    // Expense #54 and Payment #127 are active legacy transfers with no matching cash_transfers row
    await expect(
      FinanceRepository.supersedeLegacyTransferPair(54, 127, 'REENTERED_VIA_ATOMIC_CASH_TRANSFER', 1)
    ).rejects.toThrow(/CANNOT_VOID_LEGACY_TRANSFER_WITHOUT_ATOMIC_RECORD/);
  });

  it('2. Legacy PKO/RKO pair remains ACTIVE when cash_transfers row is absent', async () => {
    const { data: expense } = await db.from('expenses').select('status').eq('id', 54).single();
    const { data: payment } = await db.from('payments').select('status').eq('id', 127).single();

    expect(expense.status).toBe('ACTIVE');
    expect(payment.status).toBe('ACTIVE');
  });
});
