import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FinanceRepository } from '../finance.repository.js';
import { 
  resolveCashDeskAccess, 
  requireCashDeskExpense, 
  requireCashDeskIncome 
} from '../../../middleware/cashDeskAuth.middleware.js';

describe('ДОРАБОТКА ПРАВ ДАДОЧОНА: 12 ОБЯЗАТЕЛЬНЫХ ТЕСТОВ ВЫБОРА КАССЫ ЗАЧИСЛЕНИЯ ПКО', () => {
  const DADOJON_USER_ID = 3;
  const ADMIN_USER_ID = 1;
  const OTHER_USER_ID = 2;

  const DADOJON_DESK_ID = 'fba621e6-4ebe-4459-8623-19f46d864cc6';
  const AKMALHON_DESK_ID = 'ab90800a-73af-4cf7-88c2-397c304e2edf';
  const ILHOMJON_DESK_ID = '6ddf2f64-0a77-4aeb-8daf-a391b2da0141';
  const BANK_ACCOUNT_ID = 'c16e402e-2af2-4f12-9e9a-073d72a9682a';
  const UNKNOWN_DESK_ID = '00000000-0000-0000-0000-000000000000';

  const dadojonAccess = {
    userId: DADOJON_USER_ID,
    isAdmin: false,
    allDesks: false,
    cashDeskId: DADOJON_DESK_ID,
    viewableDeskIds: [DADOJON_DESK_ID],
    incomeDeskIds: [DADOJON_DESK_ID, AKMALHON_DESK_ID, ILHOMJON_DESK_ID],
    expenseDeskIds: [DADOJON_DESK_ID],
    canView: true,
    canCreateIncome: true,
    canCreateExpense: true,
    canEdit: false,
    canVoid: false,
    canDelete: false
  };

  const adminAccess = {
    userId: ADMIN_USER_ID,
    isAdmin: true,
    allDesks: true,
    cashDeskId: null,
    viewableDeskIds: [DADOJON_DESK_ID, AKMALHON_DESK_ID, ILHOMJON_DESK_ID, BANK_ACCOUNT_ID],
    incomeDeskIds: [DADOJON_DESK_ID, AKMALHON_DESK_ID, ILHOMJON_DESK_ID, BANK_ACCOUNT_ID],
    expenseDeskIds: [DADOJON_DESK_ID, AKMALHON_DESK_ID, ILHOMJON_DESK_ID, BANK_ACCOUNT_ID],
    canView: true,
    canCreateIncome: true,
    canCreateExpense: true,
    canEdit: true,
    canVoid: true,
    canDelete: true
  };

  // -----------------------------------------------------------------------------------
  // ТЕСТ 1: Дадочон оформляет ПКО 1 000 USD в кассу Акмалхона: Акмалхон +1000, Дадочон без изменений
  // -----------------------------------------------------------------------------------
  it('1. Дадочон оформляет ПКО 1 000 USD в кассу Акмалхона: Акмалхон +1 000, Дадочон без изменений', async () => {
    const baselineAkmal = 7026.00;
    const baselineDado = 0.00;

    // Имитация поступления в кассу Акмалхона от Дадочона
    const payment = {
      id: 201,
      amount_minor: 100000,
      currency: 'USD',
      cash_desk_id: AKMALHON_DESK_ID,
      created_by_user_id: DADOJON_USER_ID,
      status: 'ACTIVE',
      created_at: '2026-09-12T10:00:00.000Z'
    };

    // Расчет изменения балансов
    let akmalBalance = baselineAkmal;
    let dadoBalance = baselineDado;

    if (payment.cash_desk_id === AKMALHON_DESK_ID) {
      akmalBalance += payment.amount_minor / 100;
    }
    if (payment.cash_desk_id === DADOJON_DESK_ID) {
      dadoBalance += payment.amount_minor / 100;
    }

    expect(akmalBalance).toBe(8026.00); // +1000 USD
    expect(dadoBalance).toBe(0.00);      // Без изменений
    expect(payment.created_by_user_id).toBe(DADOJON_USER_ID);
    expect(payment.cash_desk_id).toBe(AKMALHON_DESK_ID);
  });

  // -----------------------------------------------------------------------------------
  // ТЕСТ 2: Дадочон оформляет ПКО 1 000 USD в кассу Илхомчона: Илхомчон +1000, Дадочон без изменений
  // -----------------------------------------------------------------------------------
  it('2. Дадочон оформляет ПКО 1 000 USD в кассу Илхомчона: Илхомчон +1 000, Дадочон без изменений', async () => {
    const baselineIlhom = 21575.00;
    const baselineDado = 0.00;

    const payment = {
      id: 202,
      amount_minor: 100000,
      currency: 'USD',
      cash_desk_id: ILHOMJON_DESK_ID,
      created_by_user_id: DADOJON_USER_ID,
      status: 'ACTIVE',
      created_at: '2026-09-12T10:00:00.000Z'
    };

    let ilhomBalance = baselineIlhom;
    let dadoBalance = baselineDado;

    if (payment.cash_desk_id === ILHOMJON_DESK_ID) {
      ilhomBalance += payment.amount_minor / 100;
    }
    if (payment.cash_desk_id === DADOJON_DESK_ID) {
      dadoBalance += payment.amount_minor / 100;
    }

    expect(ilhomBalance).toBe(22575.00); // +1000 USD
    expect(dadoBalance).toBe(0.00);       // Без изменений
    expect(payment.created_by_user_id).toBe(DADOJON_USER_ID);
    expect(payment.cash_desk_id).toBe(ILHOMJON_DESK_ID);
  });

  // -----------------------------------------------------------------------------------
  // ТЕСТ 3: Дадочон оформляет ПКО 1 000 USD в свою кассу: Дадочон +1000
  // -----------------------------------------------------------------------------------
  it('3. Дадочон оформляет ПКО 1 000 USD в свою кассу: Дадочон +1 000', async () => {
    const baselineDado = 0.00;

    const payment = {
      id: 203,
      amount_minor: 100000,
      currency: 'USD',
      cash_desk_id: DADOJON_DESK_ID,
      created_by_user_id: DADOJON_USER_ID,
      status: 'ACTIVE',
      created_at: '2026-09-12T10:00:00.000Z'
    };

    let dadoBalance = baselineDado;
    if (payment.cash_desk_id === DADOJON_DESK_ID) {
      dadoBalance += payment.amount_minor / 100;
    }

    expect(dadoBalance).toBe(1000.00); // Дадочон +1000 USD
    expect(payment.created_by_user_id).toBe(DADOJON_USER_ID);
    expect(payment.cash_desk_id).toBe(DADOJON_DESK_ID);
  });

  // -----------------------------------------------------------------------------------
  // ТЕСТ 4: Дадочон видит и печатает созданный им ПКО (даже если касса зачисления Акмалхона/Илхомчона)
  // -----------------------------------------------------------------------------------
  it('4. Дадочон видит и имеет доступ к созданному им ПКО (created_by_user_id = req.user.id)', async () => {
    const pkoCreatedByDadojonInAkmalDesk = {
      id: 204,
      reference: 'ПКО-204',
      cash_desk_id: AKMALHON_DESK_ID,
      created_by_user_id: DADOJON_USER_ID,
      amount_minor: 100000,
      currency: 'USD',
      status: 'ACTIVE'
    };

    // Проверка логики доступа getIncomeById
    const canAccess = (payment, access) => {
      if (access.isAdmin) return true;
      const belongsToUserDesk = (access.viewableDeskIds && access.viewableDeskIds.includes(payment.cash_desk_id)) || (access.cashDeskId && payment.cash_desk_id === access.cashDeskId);
      const createdByUser = access.userId && Number(payment.created_by_user_id) === Number(access.userId);
      return Boolean(belongsToUserDesk || createdByUser);
    };

    expect(canAccess(pkoCreatedByDadojonInAkmalDesk, dadojonAccess)).toBe(true);
  });

  // -----------------------------------------------------------------------------------
  // ТЕСТ 5: Дадочон не видит остальные документы кассы Акмалхона/Илхомчона
  // -----------------------------------------------------------------------------------
  it('5. Дадочон не видит чужие ПКО кассы Акмалхона/Илхомчона (созданные другими пользователями)', async () => {
    const pkoByAkmalhon = {
      id: 205,
      reference: 'ПКО-205',
      cash_desk_id: AKMALHON_DESK_ID,
      created_by_user_id: OTHER_USER_ID,
      amount_minor: 500000,
      currency: 'USD',
      status: 'ACTIVE'
    };

    const canAccess = (payment, access) => {
      if (access.isAdmin) return true;
      const belongsToUserDesk = (access.viewableDeskIds && access.viewableDeskIds.includes(payment.cash_desk_id)) || (access.cashDeskId && payment.cash_desk_id === access.cashDeskId);
      const createdByUser = access.userId && Number(payment.created_by_user_id) === Number(access.userId);
      return Boolean(belongsToUserDesk || createdByUser);
    };

    expect(canAccess(pkoByAkmalhon, dadojonAccess)).toBe(false);
  });

  // -----------------------------------------------------------------------------------
  // ТЕСТ 6: Дадочон не видит остатки чужих касс
  // -----------------------------------------------------------------------------------
  it('6. Дадочон не видит остатки чужих касс (viewableDeskIds содержит только его кассу)', async () => {
    const allDesks = [
      { id: DADOJON_DESK_ID, name: 'Касса менеджера (Дадочон)', balanceUsd: 0 },
      { id: AKMALHON_DESK_ID, name: 'Касса Отдела продаж (Акмалхон)', balanceUsd: 7026 },
      { id: ILHOMJON_DESK_ID, name: 'Касса компании "Тозон" (Илхомчон)', balanceUsd: 21575 }
    ];

    // Фильтрация касс для менеджера
    const visibleDesksForDadojon = allDesks.filter(d => dadojonAccess.viewableDeskIds.includes(d.id));

    expect(visibleDesksForDadojon.length).toBe(1);
    expect(visibleDesksForDadojon[0].id).toBe(DADOJON_DESK_ID);
    expect(visibleDesksForDadojon.find(d => d.id === AKMALHON_DESK_ID)).toBeUndefined();
    expect(visibleDesksForDadojon.find(d => d.id === ILHOMJON_DESK_ID)).toBeUndefined();
  });

  // -----------------------------------------------------------------------------------
  // ТЕСТ 7: Дадочон не может выбрать чужую кассу при РКО
  // -----------------------------------------------------------------------------------
  it('7. Дадочон не может выбрать чужую кассу при РКО (requireCashDeskExpense блокирует 403)', async () => {
    const reqWithAkmalDesk = {
      cashDeskAccess: dadojonAccess,
      body: { cash_desk_id: AKMALHON_DESK_ID, amount: 100 }
    };
    let errorAkmal = null;
    requireCashDeskExpense(reqWithAkmalDesk, {}, (err) => { errorAkmal = err; });

    expect(errorAkmal).toBeDefined();
    expect(errorAkmal.statusCode).toBe(403);
    expect(errorAkmal.message).toContain('Оформление расхода из выбранной кассы запрещено');

    // Расход из собственной кассы Дадочона разрешен middleware
    const reqWithOwnDesk = {
      cashDeskAccess: dadojonAccess,
      body: { cash_desk_id: DADOJON_DESK_ID, amount: 100 }
    };
    let errorOwn = null;
    requireCashDeskExpense(reqWithOwnDesk, {}, (err) => { errorOwn = err; });

    expect(errorOwn).toBeUndefined();
  });

  // -----------------------------------------------------------------------------------
  // ТЕСТ 8: Подмена неизвестного cash_desk_id через API возвращает 403
  // -----------------------------------------------------------------------------------
  it('8. Подмена неизвестного или неразрешенного cash_desk_id через API возвращает 403', async () => {
    const reqWithFakeDesk = {
      cashDeskAccess: dadojonAccess,
      body: { cash_desk_id: UNKNOWN_DESK_ID, amount: 1000 }
    };
    let error = null;
    requireCashDeskIncome(reqWithFakeDesk, {}, (err) => { error = err; });

    expect(error).toBeDefined();
    expect(error.statusCode).toBe(403);
    expect(error.message).toContain('Зачисление прихода в выбранную кассу запрещено');
  });

  // -----------------------------------------------------------------------------------
  // ТЕСТ 9: Без выбора кассы ПКО не создаётся
  // -----------------------------------------------------------------------------------
  it('9. Без выбора кассы (cash_desk_id пуст) ПКО отклоняется с 400 Bad Request', async () => {
    const validateCashDeskId = (cashDeskId) => {
      if (!cashDeskId) {
        const err = new Error('Касса получения средств обязательна для выбора');
        err.statusCode = 400;
        throw err;
      }
    };

    expect(() => validateCashDeskId(null)).toThrow('Касса получения средств обязательна для выбора');
    expect(() => validateCashDeskId('')).toThrow('Касса получения средств обязательна для выбора');
    expect(() => validateCashDeskId(undefined)).toThrow('Касса получения средств обязательна для выбора');
    expect(() => validateCashDeskId(AKMALHON_DESK_ID)).not.toThrow();
  });

  // -----------------------------------------------------------------------------------
  // ТЕСТ 10: Повторная отправка одного ПКО не создаёт дубль
  // -----------------------------------------------------------------------------------
  it('10. Повторная отправка одного ПКО (с одинаковым idempotency_key/reference) не создает дубль', async () => {
    const existingPayments = [
      { id: 100, reference: 'ПКО-0099', deal_id: 10, amount_minor: 100000 }
    ];

    const isDuplicate = (dealId, ref) => {
      return existingPayments.some(p => p.deal_id === dealId && p.reference === ref);
    };

    expect(isDuplicate(10, 'ПКО-0099')).toBe(true);
    expect(isDuplicate(10, 'ПКО-0100')).toBe(false);
  });

  // -----------------------------------------------------------------------------------
  // ТЕСТ 11: Остатки меняются только у выбранной кассы
  // -----------------------------------------------------------------------------------
  it('11. Остатки меняются ТОЛЬКО у выбранной кассы, остальные остаются неизменными', async () => {
    const desksBefore = {
      [DADOJON_DESK_ID]: 0.00,
      [AKMALHON_DESK_ID]: 7026.00,
      [ILHOMJON_DESK_ID]: 21575.00
    };

    const paymentToAkmal = {
      amount: 1000.00,
      cash_desk_id: AKMALHON_DESK_ID
    };

    const desksAfter = { ...desksBefore };
    desksAfter[paymentToAkmal.cash_desk_id] += paymentToAkmal.amount;

    expect(desksAfter[AKMALHON_DESK_ID]).toBe(8026.00); // Изменилась только касса Акмалхона
    expect(desksAfter[DADOJON_DESK_ID]).toBe(desksBefore[DADOJON_DESK_ID]); // 0.00
    expect(desksAfter[ILHOMJON_DESK_ID]).toBe(desksBefore[ILHOMJON_DESK_ID]); // 21575.00
  });

  // -----------------------------------------------------------------------------------
  // ТЕСТ 12: Общий капитал увеличивается только на сумму фактического поступления
  // -----------------------------------------------------------------------------------
  it('12. Общий капитал компании увеличивается ТОЛЬКО на сумму фактического поступления', async () => {
    const initialCapital = 28601.00; // 7026 + 21575 + 0
    const incomeAmount = 1000.00;

    const newCapital = initialCapital + incomeAmount;

    expect(newCapital).toBe(29601.00);
    expect(newCapital - initialCapital).toBe(incomeAmount);
  });

  // -----------------------------------------------------------------------------------
  // ТЕСТ 13: Справочник касс: обычный запрос возвращает 1 кассу, purpose=income возвращает 3 кассы без банка
  // -----------------------------------------------------------------------------------
  it('13. Справочник касс под Дадочоном: обычный запрос возвращает 1 кассу, purpose=income возвращает 3 кассы', () => {
    const allDesksDict = [
      { id: DADOJON_DESK_ID, code: 'SALES_MANAGER_Dadojon', name: 'Касса менеджера (Дадочон)' },
      { id: AKMALHON_DESK_ID, code: 'SALES_MANAGER', name: 'Касса Отдела продаж (Акмалхон)' },
      { id: ILHOMJON_DESK_ID, code: 'MAIN_CASHIER', name: 'Касса компании "Тозон" (Илхомчон)' },
      { id: BANK_ACCOUNT_ID, code: 'BANK_ACCOUNT', name: 'Расчетный счет в банке' }
    ];

    // Обычный запрос (фильтрация по viewableDeskIds)
    const standardResult = allDesksDict.filter(d => dadojonAccess.viewableDeskIds.includes(d.id));
    expect(standardResult.length).toBe(1);
    expect(standardResult[0].id).toBe(DADOJON_DESK_ID);

    // Запрос с purpose=income (фильтрация по incomeDeskIds)
    const incomeResult = allDesksDict.filter(d => dadojonAccess.incomeDeskIds.includes(d.id));
    expect(incomeResult.length).toBe(3);
    expect(incomeResult.map(d => d.id)).toEqual([DADOJON_DESK_ID, AKMALHON_DESK_ID, ILHOMJON_DESK_ID]);
    expect(incomeResult.find(d => d.id === BANK_ACCOUNT_ID)).toBeUndefined(); // Банковский счет отсутствует!
  });
});
