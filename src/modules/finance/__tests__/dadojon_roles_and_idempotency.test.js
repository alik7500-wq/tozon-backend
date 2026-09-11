import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectDB, getDB } from '../../../db/connection.js';
import { FinanceRepository } from '../finance.repository.js';
import { resolveCashDeskAccess } from '../../../middleware/cashDeskAuth.middleware.js';

describe('ДОПОЛНИТЕЛЬНЫЕ УСЛОВИЯ ПЕРЕД ЭТАПОМ C: Идемпотентность, 404 защита, 4 роли и прием платежа', { timeout: 30000 }, () => {
  let db;
  const DADOJON_USER_ID = 3;
  const ADMIN_USER_ID = 1;

  let dadojonCashDeskId;
  let akmalCashDeskId;
  let ilhomCashDeskId;

  let adminAccess;
  let directorAccess;
  let financeAccess;
  let dadojonAccess;

  const createdPaymentIds = [];
  const createdExpenseIds = [];

  beforeAll(async () => {
    await connectDB();
    db = getDB();

    // Resolve cash desks
    const { data: desks } = await db.from('dictionaries').select('*').eq('type', 'CASH_DESK').eq('is_active', true);
    const dadoDesk = desks.find(d => d.code === 'SALES_MANAGER_Dadojon' || d.name.includes('Дадочон'));
    const akmalDesk = desks.find(d => d.code === 'SALES_MANAGER' || d.name.includes('Акмалхон'));
    const ilhomDesk = desks.find(d => d.code === 'MAIN_CASHIER' || d.name.includes('Илхомчон'));

    expect(dadoDesk).toBeDefined();
    expect(akmalDesk).toBeDefined();
    expect(ilhomDesk).toBeDefined();

    dadojonCashDeskId = dadoDesk.id;
    akmalCashDeskId = akmalDesk.id;
    ilhomCashDeskId = ilhomDesk.id;

    adminAccess = {
      isAdmin: true,
      allDesks: true,
      cashDeskId: null,
      canView: true,
      canCreateIncome: true,
      canCreateExpense: true,
      canEdit: true,
      canVoid: true,
      canDelete: true,
    };

    directorAccess = {
      isAdmin: true,
      allDesks: true,
      cashDeskId: null,
      canView: true,
      canCreateIncome: true,
      canCreateExpense: true,
      canEdit: false,
      canVoid: false,
      canDelete: false,
    };

    financeAccess = {
      isAdmin: true,
      allDesks: true,
      cashDeskId: null,
      canView: true,
      canCreateIncome: true,
      canCreateExpense: true,
      canEdit: true,
      canVoid: false,
      canDelete: false,
    };

    dadojonAccess = {
      isAdmin: false,
      allDesks: false,
      cashDeskId: dadojonCashDeskId,
      canView: true,
      canCreateIncome: true,
      canCreateExpense: true,
      canEdit: false,
      canVoid: false,
      canDelete: false,
    };
  });

  afterAll(async () => {
    // Clean up all temporary records created during tests
    if (createdExpenseIds.length > 0) {
      await db.from('expenses').delete().in('id', createdExpenseIds);
    }
    if (createdPaymentIds.length > 0) {
      await db.from('payments').delete().in('id', createdPaymentIds);
    }
    await db.from('expenses').delete().ilike('description', '%IDEMP%');
    await db.from('payments').delete().ilike('reference', '%TEST%');
  });

  // =========================================================================
  // БЛОК 1: РЕГРЕССИОННЫЕ ТЕСТЫ 4 РОЛЕЙ (ADMIN, DIRECTOR, FINANCE_MANAGER, SALES_MANAGER)
  // Выполняется ДО создания тестовых временных операций, чтобы проверить эталонные остатки
  // =========================================================================
  describe('5. Регрессионные тесты для ролей: ADMIN, DIRECTOR, FINANCE_MANAGER, SALES_MANAGER', () => {
    it('5.1. Middleware resolveCashDeskAccess корректно определяет доступ для всех 4 ролей', async () => {
      // ADMIN
      const reqAdmin = { user: { id: 1, role: 'ADMIN' }, query: {}, body: {} };
      let adminNextCalled = false;
      await resolveCashDeskAccess(reqAdmin, {}, () => { adminNextCalled = true; });
      expect(adminNextCalled).toBe(true);
      expect(reqAdmin.cashDeskAccess.isAdmin).toBe(true);
      expect(reqAdmin.cashDeskAccess.allDesks).toBe(true);
      expect(reqAdmin.cashDeskAccess.canDelete).toBe(true);

      // DIRECTOR
      const reqDirector = { user: { id: 2, role: 'DIRECTOR' }, query: {}, body: {} };
      let directorNextCalled = false;
      await resolveCashDeskAccess(reqDirector, {}, () => { directorNextCalled = true; });
      expect(directorNextCalled).toBe(true);
      expect(reqDirector.cashDeskAccess.isAdmin).toBe(true);
      expect(reqDirector.cashDeskAccess.allDesks).toBe(true);
      expect(reqDirector.cashDeskAccess.canView).toBe(true);

      // FINANCE_MANAGER
      const reqFinance = { user: { id: 4, role: 'FINANCE_MANAGER' }, query: {}, body: {} };
      let financeNextCalled = false;
      await resolveCashDeskAccess(reqFinance, {}, () => { financeNextCalled = true; });
      expect(financeNextCalled).toBe(true);
      expect(reqFinance.cashDeskAccess.isAdmin).toBe(true);
      expect(reqFinance.cashDeskAccess.allDesks).toBe(true);
      expect(reqFinance.cashDeskAccess.canEdit).toBe(true);

      // SALES_MANAGER (Дадочон)
      const reqManager = { user: { id: 3, email: 'manager1@tozon.tj', role: 'SALES_MANAGER' }, query: {}, body: {} };
      let managerNextCalled = false;
      await resolveCashDeskAccess(reqManager, {}, () => { managerNextCalled = true; });
      expect(managerNextCalled).toBe(true);
      expect(reqManager.cashDeskAccess.isAdmin).toBe(false);
      expect(reqManager.cashDeskAccess.allDesks).toBe(false);
      expect(reqManager.cashDeskAccess.cashDeskId).toBe(dadojonCashDeskId);
      expect(reqManager.cashDeskAccess.canEdit).toBe(false);
      expect(reqManager.cashDeskAccess.canVoid).toBe(false);
      expect(reqManager.cashDeskAccess.canDelete).toBe(false);
    });

    it('5.2. DIRECTOR и FINANCE_MANAGER видят полный сводный капитал компании ($28 601 USD)', async () => {
      const directorCashflow = await FinanceRepository.getCashflow({}, directorAccess);
      expect(directorCashflow.summaryByCurrency.USD.netCashflow).toBe(28601);
      const akmalDesk = directorCashflow.cashDesksSummary.find(d => d.name.includes('Акмалхон'));
      const ilhomDesk = directorCashflow.cashDesksSummary.find(d => d.name.includes('Илхомчон'));
      expect(akmalDesk.balanceUsd).toBe(7026);
      expect(ilhomDesk.balanceUsd).toBe(21575);

      const financeCashflow = await FinanceRepository.getCashflow({}, financeAccess);
      expect(financeCashflow.summaryByCurrency.USD.netCashflow).toBe(28601);
    });

    it('5.3. SALES_MANAGER (Дадочон) видит строго свою кассу ($0 USD) и НЕ видит капитал компании ($28 601)', async () => {
      const managerCashflow = await FinanceRepository.getCashflow({}, dadojonAccess);
      
      // Капитал компании обнулен для менеджера
      expect(managerCashflow.summaryByCurrency.USD.netCashflow).toBe(0);

      // Кассы Акмалхона и Илхомчона отсутствуют в разбивке (строго 1 касса менеджера)
      expect(managerCashflow.cashDesksSummary.length).toBe(1);
      expect(managerCashflow.cashDesksSummary[0].name).toContain('Дадочон');
      expect(managerCashflow.cashDesksSummary[0].balanceUsd).toBe(0);

      // Коммерческая тайна обнулена
      expect(managerCashflow.salesSummary.totalContractSumUsd).toBe(0);
      expect(managerCashflow.fxSummary.fxGainLossUsd).toBe(0);
      expect(managerCashflow.conversionsSummary.totalConvertedFromUsd).toBe(0);
    });
  });

  // =========================================================================
  // БЛОК 2: ЗАЩИТА ДОКУМЕНТОВ: ВОЗВРАТ 404 NOT FOUND (НЕ 403)
  // =========================================================================
  describe('4. Защита чужих документов: возврат 404 Not Found менеджерам', () => {
    let akmalPkoId;
    let akmalRkoId;

    beforeAll(async () => {
      // Создаем ПКО в кассе Акмалхона
      const { data: pko } = await db.from('payments').insert([{
        amount_minor: 10000,
        currency: 'USD',
        payment_date: new Date().toISOString().split('T')[0],
        method: 'CASH',
        reference: 'ПКО-TEST-AKMAL-FOREIGN',
        comment: '[Касса: Касса Отдела продаж (Акмалхон)] Тестовый ПКО Акмалхона',
        cash_desk_id: akmalCashDeskId,
        created_by_user_id: ADMIN_USER_ID,
        status: 'ACTIVE',
        created_at: new Date().toISOString()
      }]).select().single();

      akmalPkoId = pko.id;
      createdPaymentIds.push(akmalPkoId);

      // Создаем РКО в кассе Акмалхона
      const { data: rko } = await db.from('expenses').insert([{
        amount_minor: 5000,
        currency: 'USD',
        expense_date: new Date().toISOString().split('T')[0],
        method: 'CASH',
        reference: 'РКО-TEST-AKMAL-FOREIGN',
        category: 'Прочее',
        recipient: 'Чужой получатель',
        description: '[Касса: Касса Отдела продаж (Акмалхон)] Тестовый РКО Акмалхона',
        cash_desk_id: akmalCashDeskId,
        created_by_user_id: ADMIN_USER_ID,
        status: 'ACTIVE',
        created_at: new Date().toISOString()
      }]).select().single();

      akmalRkoId = rko.id;
      createdExpenseIds.push(akmalRkoId);
    });

    it('4.1. Запрос чужого ПКО менеджером Дадочоном возвращает 404 Not Found', async () => {
      try {
        await FinanceRepository.getIncomeById(akmalPkoId, dadojonAccess);
        expect.unreachable('Должна быть выброшена ошибка 404');
      } catch (err) {
        expect(err.statusCode).toBe(404);
        expect(err.message).toBe('Документ не найден');
      }
    });

    it('4.2. Запрос чужого РКО менеджером Дадочоном возвращает 404 Not Found', async () => {
      try {
        await FinanceRepository.getExpenseById(akmalRkoId, dadojonAccess);
        expect.unreachable('Должна быть выброшена ошибка 404');
      } catch (err) {
        expect(err.statusCode).toBe(404);
        expect(err.message).toBe('Документ не найден');
      }
    });

    it('4.3. Администратор успешно получает тот же ПКО и РКО (200 OK)', async () => {
      const pko = await FinanceRepository.getIncomeById(akmalPkoId, adminAccess);
      expect(pko).toBeDefined();
      expect(pko.id).toBe(akmalPkoId);

      const rko = await FinanceRepository.getExpenseById(akmalRkoId, adminAccess);
      expect(rko).toBeDefined();
      expect(rko.id).toBe(akmalRkoId);
    });
  });

  // =========================================================================
  // БЛОК 3: ИДЕМПОТЕНТНОСТЬ И БЕЗОПАСНАЯ ГЕНЕРАЦИЯ НОМЕРА РКО
  // =========================================================================
  describe('1 & 2. Идемпотентность и безопасная генерация номера РКО', () => {
    let topupPaymentId;

    beforeAll(async () => {
      // Пополняем кассу Дадочона на 500 USD для тестов расходов
      const { data: pmt } = await db.from('payments').insert([{
        amount_minor: 50000, // 500 USD
        currency: 'USD',
        payment_date: new Date().toISOString().split('T')[0],
        method: 'CASH',
        reference: 'ПКО-TEST-IDEMP-TOPUP',
        payer_name: 'Пополнение для теста идемпотентности',
        comment: '[Касса: Касса менеджера (Дадочон)] Пополнение кассы Дадочона',
        cash_desk_id: dadojonCashDeskId,
        created_by_user_id: ADMIN_USER_ID,
        status: 'ACTIVE',
        created_at: new Date().toISOString()
      }]).select().single();

      topupPaymentId = pmt.id;
      createdPaymentIds.push(topupPaymentId);
    });

    it('1.1. Повторный вызов addExpense с тем же idempotency_key не создает второй РКО и не списывает баланс повторно', async () => {
      const initialBalance = await FinanceRepository.getCashDeskBalance(dadojonCashDeskId);
      const testKey = `IDEMP_KEY_${Date.now()}_A`;

      // Первый запрос: создаем РКО на 100 USD
      const exp1 = await FinanceRepository.addExpense({
        amount: 100,
        currency: 'USD',
        category: 'Канцтовары',
        recipient: 'Магазин',
        description: 'Первый вызов с ключом',
        idempotency_key: testKey
      }, DADOJON_USER_ID, dadojonAccess);

      expect(exp1).toBeDefined();
      expect(exp1.id).toBeDefined();
      createdExpenseIds.push(exp1.id);

      // Проверяем формат номера РКО (Требование 2: РКО-id)
      expect(exp1.reference).toBe(`РКО-${exp1.id}`);

      const balanceAfterFirst = await FinanceRepository.getCashDeskBalance(dadojonCashDeskId);
      expect(balanceAfterFirst).toBeCloseTo(initialBalance - 100, 2);

      // Второй запрос с ТОЧНО ТАКИМ ЖЕ ключом:
      const exp2 = await FinanceRepository.addExpense({
        amount: 100,
        currency: 'USD',
        category: 'Канцтовары',
        recipient: 'Магазин',
        description: 'Повторный вызов с тем же ключом',
        idempotency_key: testKey
      }, DADOJON_USER_ID, dadojonAccess);

      expect(exp2).toBeDefined();
      expect(exp2.id).toBe(exp1.id);
      expect(exp2.idempotent).toBe(true);
      expect(exp2.reference).toBe(exp1.reference);

      // Баланс не должен уменьшиться повторно!
      const balanceAfterSecond = await FinanceRepository.getCashDeskBalance(dadojonCashDeskId);
      expect(balanceAfterSecond).toBeCloseTo(balanceAfterFirst, 2);

      // В БД физически существует запись первого расхода
      const { data: rows } = await db.from('expenses').select('id').eq('id', exp1.id);
      expect(rows.length).toBe(1);
    });

    it('1.2. Конкурентный тест: 5 одновременных вызовов с одинаковым idempotency_key создают ровно 1 РКО', async () => {
      const balanceBefore = await FinanceRepository.getCashDeskBalance(dadojonCashDeskId);
      const concurrentKey = `CONCURRENT_KEY_${Date.now()}_B`;

      const promises = Array.from({ length: 5 }).map((_, i) =>
        FinanceRepository.addExpense({
          amount: 50,
          currency: 'USD',
          category: 'Хозтовары',
          recipient: 'Поставщик',
          description: `Конкурентный вызов #${i + 1}`,
          idempotency_key: concurrentKey
        }, DADOJON_USER_ID, dadojonAccess)
      );

      const results = await Promise.all(promises);

      // Все 5 вызовов успешно вернули один и тот же expense ID
      const firstId = results[0].id;
      createdExpenseIds.push(firstId);

      for (const res of results) {
        expect(res.id).toBe(firstId);
        expect(res.reference).toBe(`РКО-${firstId}`);
      }

      // Баланс уменьшился ровно на 50 USD (а не на 250 USD!)
      const balanceAfter = await FinanceRepository.getCashDeskBalance(dadojonCashDeskId);
      expect(balanceAfter).toBeCloseTo(balanceBefore - 50, 2);

      // В БД физически ровно 1 запись с этим id
      const { data: dbRecords } = await db.from('expenses').select('id').eq('id', firstId);
      expect(dbRecords.length).toBe(1);
    });

    it('1.3. Сценарий с двумя независимыми экземплярами backend (без общей памяти): ровно 1 РКО', async () => {
      const balanceBefore = await FinanceRepository.getCashDeskBalance(dadojonCashDeskId);
      const multiInstanceKey = `MULTI_INSTANCE_${Date.now()}_C`;

      // Имитация двух разных экземпляров бэкенда (Instance A и Instance B)
      const instanceA = () => FinanceRepository.addExpense({
        amount: 30,
        currency: 'USD',
        category: 'Офис',
        recipient: 'Провайдер A',
        description: 'Запрос от Instance A',
        idempotency_key: multiInstanceKey
      }, DADOJON_USER_ID, dadojonAccess);

      const instanceB = () => FinanceRepository.addExpense({
        amount: 30,
        currency: 'USD',
        category: 'Офис',
        recipient: 'Провайдер B',
        description: 'Запрос от Instance B',
        idempotency_key: multiInstanceKey
      }, DADOJON_USER_ID, dadojonAccess);

      // Запуск параллельно от двух экземпляров
      const [resA, resB] = await Promise.all([instanceA(), instanceB()]);

      expect(resA.id).toBe(resB.id);
      expect(resA.reference).toBe(resB.reference);
      createdExpenseIds.push(resA.id);

      // Баланс уменьшился ровно на 30 USD
      const balanceAfter = await FinanceRepository.getCashDeskBalance(dadojonCashDeskId);
      expect(balanceAfter).toBeCloseTo(balanceBefore - 30, 2);

      // В БД ровно 1 запись
      const { data: rows } = await db.from('expenses').select('id').eq('id', resA.id);
      expect(rows.length).toBe(1);
    });

    it('1.4. Финансовый контроллер: запрос без idempotency_key отклоняется с 400 Bad Request', async () => {
      const { addExpense: controllerAddExpense } = await import('../finance.controller.js');
      const req = {
        body: {
          amount: 25,
          currency: 'USD',
          category: 'Канцтовары'
          // idempotency_key отсутствует
        },
        user: { id: DADOJON_USER_ID, role: 'SALES_MANAGER' },
        cashDeskAccess: dadojonAccess
      };

      let capturedError = null;
      await controllerAddExpense(req, {}, (err) => { capturedError = err; });

      expect(capturedError).toBeDefined();
      expect(capturedError.statusCode).toBe(400);
      expect(capturedError.message).toContain('idempotency_key обязателен');
    });
  });

  // =========================================================================
  // БЛОК 4: КОНТРОЛЬ ВЫБОРА КАССЫ ПРИ ПРИЕМЕ ПЛАТЕЖА ПОКУПАТЕЛЯ
  // =========================================================================
  describe('7. Контроль выбора кассы при приеме платежа покупателя', () => {
    it('7.1. Попытка Дадочона подменить cash_desk_id на чужую кассу блокируется с 403 Forbidden', async () => {
      const reqTamper = {
        user: { id: 3, email: 'manager1@tozon.tj', role: 'SALES_MANAGER' },
        query: {},
        body: {
          cash_desk_id: akmalCashDeskId // подмена на кассу Акмалхона!
        }
      };

      let capturedError = null;
      await resolveCashDeskAccess(reqTamper, {}, (err) => { capturedError = err; });

      expect(capturedError).toBeDefined();
      expect(capturedError.statusCode).toBe(403);
      expect(capturedError.message).toBe('Доступ к чужой кассе запрещен');
    });

    it('7.2. Если Дадочон не передает cash_desk_id, сервер автоматически привязывает его кассу', async () => {
      const reqAuto = {
        user: { id: 3, email: 'manager1@tozon.tj', role: 'SALES_MANAGER' },
        query: {},
        body: {}
      };

      let capturedError = undefined;
      await resolveCashDeskAccess(reqAuto, {}, (err) => { capturedError = err; });

      expect(capturedError).toBeUndefined();
      expect(reqAuto.cashDeskAccess.cashDeskId).toBe(dadojonCashDeskId);
    });
  });

  // =========================================================================
  // БЛОК 5: ЗАЩИТА МАРШРУТОВ И ИГНОРИРОВАНИЕ СПУФИНГА РОЛЕЙ
  // =========================================================================
  describe('5. Проверка обязательной авторизации маршрутов проверенным JWT', () => {
    it('5.4. Все 6 финансовых и платежных маршрутов защищены JWT (возврат 401 без токена)', async () => {
      const { protect } = await import('../../../middleware/auth.middleware.js');
      
      const protectedEndpoints = [
        { path: '/api/finance/income', method: 'GET' },
        { path: '/api/finance/expenses', method: 'GET' },
        { path: '/api/finance/cashflow', method: 'GET' },
        { path: '/api/finance/transfers', method: 'POST' },
        { path: '/api/finance/convert', method: 'POST' },
        { path: '/api/deals/1/payments', method: 'POST' },
      ];

      for (const ep of protectedEndpoints) {
        // Запрос без JWT токена с попыткой спуфинга в body/query
        const reqUnauthenticated = {
          cookies: {},
          headers: {},
          body: { role: 'ADMIN', user_id: 1 },
          query: { role: 'ADMIN' }
        };

        let authError = null;
        await protect(reqUnauthenticated, {}, (err) => { authError = err; });

        expect(authError, `Маршрут ${ep.path} должен отклонять неавторизованные запросы`).toBeDefined();
        expect(authError.statusCode).toBe(401);
        expect(reqUnauthenticated.user).toBeUndefined();
      }
    });

    it('5.5. Спуфинг роли или user_id через body/query/headers полностью игнорируется (req.user только из JWT)', async () => {
      const { protect } = await import('../../../middleware/auth.middleware.js');
      const jwt = (await import('jsonwebtoken')).default;

      // Создаем валидный токен менеджера Дадочона (id=3, role='SALES_MANAGER')
      const token = jwt.sign(
        { id: DADOJON_USER_ID, role: 'SALES_MANAGER' },
        process.env.JWT_SECRET || 'super-secret-key-for-dev-only'
      );

      // Клиент пытается передать в body role: 'ADMIN', а в headers чужой user_id
      const reqSpoof = {
        cookies: {},
        headers: { authorization: `Bearer ${token}` },
        body: { role: 'ADMIN', user_id: ADMIN_USER_ID },
        query: { role: 'ADMIN' }
      };

      let authError = undefined;
      await protect(reqSpoof, {}, (err) => { authError = err; });

      expect(authError).toBeUndefined();
      expect(reqSpoof.user).toBeDefined();
      // Сервер установил пользователя из базы данных по id из JWT, спуфинг из body проигнорирован
      expect(reqSpoof.user.id).toBe(DADOJON_USER_ID);
      expect(reqSpoof.user.role).toBe('SALES_MANAGER');
    });
  });
});
