import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FinanceRepository } from '../finance.repository.js';
import { getDB } from '../../../db/connection.js';

vi.mock('../../../db/connection.js', () => {
  const mockDb = {
    from: vi.fn(),
    rpc: vi.fn()
  };
  return {
    getDB: () => mockDb
  };
});

describe('CASH DESK SOURCE OF TRUTH HARDENING TEST SUITE', () => {
  let mockDb;
  const AKMAL_DESK_ID = 'ab90800a-73af-4cf7-88c2-397c304e2edf';
  const ILHOM_DESK_ID = '6ddf2f64-0a77-4aeb-8daf-a391b2da0141';

  beforeEach(() => {
    mockDb = getDB();
    vi.clearAllMocks();

    mockDb.from.mockImplementation((table) => {
      if (table === 'dictionaries') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockResolvedValue({
            data: [
              { id: AKMAL_DESK_ID, code: 'SALES_MANAGER', name: 'Касса Отдела продаж (Акмалхон)' },
              { id: ILHOM_DESK_ID, code: 'MAIN_CASHIER', name: 'Касса компании "Тозон" (Илхомчон)' }
            ],
            error: null
          })
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        delete: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        single: vi.fn().mockResolvedValue({ data: null, error: null })
      };
    });
  });

  // TEST 1: PKO without cash_desk_id → rejected with 400
  it('1. PKO (addIncome) без cash_desk_id отклоняется с ошибкой 400 CASH_DESK_REQUIRED', async () => {
    const payload = {
      amount: '100',
      currency: 'USD',
      payer_name: 'Тестовый клиент'
    };

    await expect(FinanceRepository.addIncome(payload, 1, { isAdmin: true }))
      .rejects.toThrow('Касса зачисления обязательна (cash_desk_id)');
  });

  // TEST 2: RKO without cash_desk_id → rejected with 400
  it('2. RKO (addExpense) без cash_desk_id отклоняется с ошибкой 400 CASH_DESK_REQUIRED', async () => {
    const payload = {
      amount: '50',
      currency: 'USD',
      recipient: 'Тестовый контрагент'
    };

    await expect(FinanceRepository.addExpense(payload, 1, { isAdmin: true }))
      .rejects.toThrow('Касса списания обязательна (cash_desk_id)');
  });

  // TEST 3: Conversion without from_cash_desk_id → rejected
  it('3. Конвертация без from_cash_desk_id отклоняется с ошибкой 400 CONVERSION_CASH_DESKS_REQUIRED', async () => {
    const payload = {
      to_cash_desk_id: ILHOM_DESK_ID,
      from_amount: 100,
      from_currency: 'USD',
      to_currency: 'TJS'
    };

    await expect(FinanceRepository.convertCurrency(payload, 1))
      .rejects.toThrow('Для конвертации валют обязательны исходная и целевая кассы');
  });

  // TEST 4: Conversion without to_cash_desk_id → rejected
  it('4. Конвертация без to_cash_desk_id отклоняется с ошибкой 400 CONVERSION_CASH_DESKS_REQUIRED', async () => {
    const payload = {
      from_cash_desk_id: AKMAL_DESK_ID,
      from_amount: 100,
      from_currency: 'USD',
      to_currency: 'TJS'
    };

    await expect(FinanceRepository.convertCurrency(payload, 1))
      .rejects.toThrow('Для конвертации валют обязательны исходная и целевая кассы');
  });

  // TEST 5: Internal transfer without source or dest → rejected
  it('5. Внутреннее перемещение без source или destination cash desk отклоняется', async () => {
    const payloadNoSource = {
      destination_cash_desk_id: ILHOM_DESK_ID,
      amount: 200,
      currency: 'USD'
    };

    await expect(FinanceRepository.createCashTransfer(payloadNoSource, 1))
      .rejects.toThrow('Для внутреннего перемещения обязательны исходная и целевая кассы');
  });

  // TEST 6: PATCH without cash_desk_id preserves existing cash desk
  it('6. PATCH (updateIncome) без cash_desk_id сохраняет исходную кассу', async () => {
    const existingPko = {
      id: 10,
      amount_minor: 10000,
      currency: 'USD',
      cash_desk_id: AKMAL_DESK_ID,
      comment: 'Исходное примечание'
    };

    const updateChain = {
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: [{ ...existingPko, comment: 'Обновленное примечание' }], error: null })
    };

    mockDb.from.mockImplementation((table) => {
      if (table === 'payments') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: existingPko, error: null }),
          update: vi.fn().mockReturnValue(updateChain)
        };
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });

    const result = await FinanceRepository.updateIncome(10, { comment: 'Обновленное примечание' }, 'ADMIN', { isAdmin: true });
    expect(result.cash_desk_id).toBe(AKMAL_DESK_ID);
  });

  // TEST 7: PATCH cash desk does not change amount
  it('7. Изменение cash_desk_id через PATCH не меняет сумму документа', async () => {
    const existingPko = {
      id: 10,
      amount_minor: 50000,
      currency: 'USD',
      cash_desk_id: AKMAL_DESK_ID
    };

    let updatePayloadCaptured = null;

    mockDb.from.mockImplementation((table) => {
      if (table === 'payments') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: existingPko, error: null }),
          update: vi.fn().mockImplementation((payload) => {
            updatePayloadCaptured = payload;
            return {
              eq: vi.fn().mockReturnThis(),
              select: vi.fn().mockResolvedValue([{ ...existingPko, cash_desk_id: ILHOM_DESK_ID }])
            };
          })
        };
      }
      if (table === 'dictionaries') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockResolvedValue({
            data: [{ id: ILHOM_DESK_ID, code: 'MAIN_CASHIER', name: 'Касса компании "Тозон" (Илхомчон)' }],
            error: null
          })
        };
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });

    await FinanceRepository.updateIncome(10, { cash_desk_id: ILHOM_DESK_ID }, 'ADMIN', { isAdmin: true });
    expect(updatePayloadCaptured.cash_desk_id).toBe(ILHOM_DESK_ID);
    expect(updatePayloadCaptured.amount_minor).toBeUndefined();
  });

  // TEST 8: Explicit null in PATCH cash_desk_id rejected for active doc
  it('8. Попытка передать cash_desk_id = null при PATCH отклоняется с ошибкой 400', async () => {
    const existingExpense = {
      id: 20,
      amount_minor: 3000,
      currency: 'USD',
      cash_desk_id: AKMAL_DESK_ID
    };

    mockDb.from.mockImplementation((table) => {
      if (table === 'expenses') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: existingExpense, error: null })
        };
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });

    await expect(FinanceRepository.updateExpense(20, { cash_desk_id: null }, 'ADMIN', { isAdmin: true }))
      .rejects.toThrow('Отвязка кассы (null) запрещена для активных финансовых документов');
  });

  // TEST 9: No silent fallback to MAIN_CASHIER
  it('9. Отсутствие cash_desk_id не подменяется скрыто на MAIN_CASHIER в ДДС', async () => {
    const orphanPayment = {
      id: 999,
      amount_minor: 1000,
      currency: 'USD',
      payment_date: '2026-09-14',
      status: 'ACTIVE',
      cash_desk_id: null,
      comment: 'Платеж без кассы'
    };

    mockDb.from.mockImplementation((table) => {
      if (table === 'payments') {
        return { select: vi.fn().mockResolvedValue({ data: [orphanPayment], error: null }) };
      }
      if (table === 'expenses') {
        return { select: vi.fn().mockResolvedValue({ data: [], error: null }) };
      }
      if (table === 'deals') {
        return { select: vi.fn().mockResolvedValue({ data: [], error: null }) };
      }
      if (table === 'dictionaries') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockResolvedValue({
            data: [{ id: ILHOM_DESK_ID, code: 'MAIN_CASHIER', name: 'Касса компании "Тозон" (Илхомчон)' }],
            error: null
          })
        };
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });

    const cashflow = await FinanceRepository.getCashflow({ year: 2026 }, { isAdmin: true });
    const tx = cashflow.transactions.find(t => t.rawId === 999);
    expect(tx.cashDeskName).toBe('Без кассы');
    expect(tx.cashDeskName).not.toBe('Касса компании "Тозон" (Иlхомчон)');
  });

  // TEST 10: Internal transfer uses structured source/destination IDs via RPC
  it('10. Внутреннее перемещение с валидными source/destination передает их в rpc create_atomic_cash_transfer', async () => {
    mockDb.rpc.mockResolvedValue({
      data: { transfer_id: 'tx-123', status: 'SUCCESS' },
      error: null
    });

    const payload = {
      source_cash_desk_id: AKMAL_DESK_ID,
      destination_cash_desk_id: ILHOM_DESK_ID,
      amount: 500,
      currency: 'USD',
      description: 'Тестовое перемещение'
    };

    await FinanceRepository.createCashTransfer(payload, 1);

    expect(mockDb.rpc).toHaveBeenCalledWith('create_atomic_cash_transfer', expect.objectContaining({
      p_source_cash_desk_id: AKMAL_DESK_ID,
      p_destination_cash_desk_id: ILHOM_DESK_ID,
      p_currency: 'USD'
    }));
  });
});
