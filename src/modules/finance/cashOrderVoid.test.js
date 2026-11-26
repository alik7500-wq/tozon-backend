import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn()
  };
  return { query, db: { from: vi.fn(() => query), rpc: vi.fn() } };
});
vi.mock('../../db/connection.js', () => ({
  getDB: () => mock.db, getServiceDB: () => mock.db
}));
import { FinanceRepository } from './finance.repository.js';

const access = { isAdmin: true, userId: 9 };
beforeEach(() => vi.clearAllMocks());

describe('cash order annulment', () => {
  it('keeps the RKO and records who voided it', async () => {
    mock.query.maybeSingle.mockResolvedValueOnce({ data: { id: 8, status: 'ACTIVE' } })
      .mockResolvedValueOnce({ data: { id: 8 } });
    await FinanceRepository.deleteExpense(8, 'ADMIN', access);
    expect(mock.db.from).toHaveBeenCalledWith('expenses');
    expect(mock.query.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'VOIDED', voided_by: 9, voided_at: expect.any(String)
    }));
    expect(mock.query.delete).not.toHaveBeenCalled();
  });

  it('uses the atomic PKO routine that recalculates the payment schedule', async () => {
    mock.query.maybeSingle.mockResolvedValueOnce({ data: { id: 3, deal_id: 44, status: 'ACTIVE' } });
    mock.db.rpc.mockResolvedValueOnce({ data: { success: true } });
    await FinanceRepository.deleteIncome(3, 'ADMIN', access);
    expect(mock.db.rpc).toHaveBeenCalledWith('void_income_payment_atomic', expect.objectContaining({ p_payment_id: 3, p_user_id: 9 }));
  });

  it.each([
    ['deleteIncome', { transfer_id: 'linked-transfer' }],
    ['deleteExpense', { conversion_expense_id: 25 }],
    ['deleteExpense', { reference: 'КОНВ-1002' }]
  ])('refuses a paired operation through %s', async (method, fields) => {
    mock.query.maybeSingle.mockResolvedValueOnce({ data: { status: 'ACTIVE', ...fields } });
    await expect(FinanceRepository[method](8, 'ADMIN', access)).rejects.toThrow(/Отдельно аннулировать/);
    expect(mock.query.update).not.toHaveBeenCalled();
    expect(mock.db.rpc).not.toHaveBeenCalled();
  });

  it('does not mutate when permission or the original row is missing', async () => {
    await expect(FinanceRepository.deleteExpense(8, 'SALES_MANAGER', access)).rejects.toThrow(/только администратору/);
    expect(mock.db.from).not.toHaveBeenCalled();
    mock.query.maybeSingle.mockResolvedValueOnce({ data: null });
    await expect(FinanceRepository.deleteIncome(8, 'ADMIN', access)).rejects.toThrow(/не найден/);
    expect(mock.query.delete).not.toHaveBeenCalled();
    expect(mock.db.rpc).not.toHaveBeenCalled();
  });
});
