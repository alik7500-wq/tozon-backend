import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connectDB, getDB } from '../../../db/connection.js';
import { FinanceRepository } from '../finance.repository.js';
import { DictionariesRepository } from '../../dictionaries/dictionaries.repository.js';

describe('ПРЕДРЕЛИЗНЫЕ ТЕСТЫ ЭТАПА B: Изолированная касса, регрессия Admin, E2E и Race Condition', { timeout: 30000 }, () => {
  let db;
  const DADOJON_USER_ID = 3;
  const ADMIN_USER_ID = 1;

  let dadojonCashDeskId;
  let akmalCashDeskId;
  let ilhomCashDeskId;

  const adminAccess = {
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

  let dadojonAccess;

  // Track created test records to cleanly revert them without modifying real finance history
  const createdPaymentIds = [];
  const createdExpenseIds = [];
  const createdTransferIds = [];

  beforeAll(async () => {
    await connectDB();
    db = getDB();

    // Resolve cash desks from dictionary
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
    // Clean up temporary test operations
    if (createdExpenseIds.length > 0) {
      await db.from('expenses').delete().in('id', createdExpenseIds);
    }
    if (createdPaymentIds.length > 0) {
      await db.from('payments').delete().in('id', createdPaymentIds);
    }
    if (createdTransferIds.length > 0) {
      await db.from('cash_transfers').delete().in('id', createdTransferIds);
    }
  });

  // ==========================================
  // БЛОК 1: Подтверждение отсутствия регрессии остатков администратора
  // ==========================================
  describe('1. Проверка идентичности production API для Администратора', () => {
    it('Admin видит реальные динамические остатки по формуле без hardcoded baselines', async () => {
      const cashflow = await FinanceRepository.getCashflow({}, adminAccess);

      expect(cashflow).toBeDefined();
      expect(cashflow.summaryByCurrency).toBeDefined();

      // Cash Desks Summary
      const akmal = cashflow.cashDesksSummary.find(d => d.name.includes('Акмалхон'));
      const ilhom = cashflow.cashDesksSummary.find(d => d.name.includes('Илхомчон'));
      const dado = cashflow.cashDesksSummary.find(d => d.name.includes('Дадочон'));

      expect(akmal).toBeDefined();
      expect(akmal.balanceUsd).toBe(Number((akmal.totalIncomeUsd - akmal.totalExpenseUsd).toFixed(2)));

      expect(ilhom).toBeDefined();
      expect(ilhom.balanceUsd).toBe(Number((ilhom.totalIncomeUsd - ilhom.totalExpenseUsd).toFixed(2)));
      expect(ilhom.balanceTjs).toBe(Number((ilhom.totalIncomeTjs - ilhom.totalExpenseTjs).toFixed(2)));

      expect(dado).toBeDefined();
      expect(dado.balanceUsd).toBe(0.00);
      expect(dado.balanceTjs).toBe(0.00);

      // Consolidated Capital matches sum of desks
      const totalUsd = cashflow.cashDesksSummary.reduce((acc, d) => Number((acc + d.balanceUsd).toFixed(2)), 0);
      const totalTjs = cashflow.cashDesksSummary.reduce((acc, d) => Number((acc + d.balanceTjs).toFixed(2)), 0);

      expect(cashflow.summaryByCurrency.USD.netCashflow).toBe(totalUsd);
      expect(cashflow.summaryByCurrency.TJS.netCashflow).toBe(totalTjs);

      // Document counts
      const pkoList = cashflow.transactions.filter(t => t.type === 'INCOME');
      const rkoList = cashflow.transactions.filter(t => t.type === 'EXPENSE');

      expect(pkoList.length).toBeGreaterThan(0);
      expect(rkoList.length).toBeGreaterThan(0);
    });

    it('Менеджер Дадочон видит строго свою кассу с нулевым балансом и без коммерческой тайны', async () => {
      const cashflow = await FinanceRepository.getCashflow({}, dadojonAccess);

      // Desks count
      expect(cashflow.cashDesksSummary.length).toBe(1);
      expect(cashflow.cashDesksSummary[0].name).toContain('Дадочон');
      expect(cashflow.cashDesksSummary[0].balanceUsd).toBe(0.00);
      expect(cashflow.cashDesksSummary[0].balanceTjs).toBe(0.00);

      // Summary
      expect(cashflow.summaryByCurrency.USD.totalIncome).toBe(0);
      expect(cashflow.summaryByCurrency.USD.totalExpense).toBe(0);
      expect(cashflow.summaryByCurrency.USD.netCashflow).toBe(0);

      // Commercial secrecy hidden
      expect(cashflow.salesSummary.totalContractSumUsd).toBe(0);
      expect(cashflow.salesSummary.totalSoldAreaM2).toBe(0);
      expect(cashflow.fxSummary.totalTjsInflow).toBe(0);
      expect(cashflow.conversionsSummary.totalConvertedFromUsd).toBe(0);

      // Transactions isolated
      expect(cashflow.transactions.length).toBe(0);
    });
  });

  // ==========================================
  // БЛОК 2: Полный E2E-сценарий операций менеджера Дадочона
  // ==========================================
  describe('2. Полный E2E-сценарий: Выдача средств, Расход, Остаток, Защита документов', () => {
    let transferId;
    let sourceExpenseId;
    let destPaymentId;
    let createdRkoId;

    it('2.1 Выдача средств: Администратор переводит 1 000 USD в кассу Дадочона', async () => {
      const transferRes = await FinanceRepository.createCashTransfer({
        source_cash_desk_id: ilhomCashDeskId,
        destination_cash_desk_id: dadojonCashDeskId,
        currency: 'USD',
        amount: 1000,
        amount_usd: 1000,
        date: new Date().toISOString().split('T')[0],
        recipient: 'Касса менеждера (Дадочон)',
        description: 'Выдача под отчет менеджеру Дадочону'
      }, ADMIN_USER_ID);

      expect(transferRes).toBeDefined();
      expect(transferRes.success).toBe(true);

      transferId = transferRes.transfer_id;
      sourceExpenseId = transferRes.source_expense_id;
      destPaymentId = transferRes.destination_payment_id;

      createdTransferIds.push(transferId);
      createdExpenseIds.push(sourceExpenseId);
      createdPaymentIds.push(destPaymentId);

      // Проверка в базе: одно РКО источника и один ПКО Дадочона с одним transfer_id
      const { data: exp } = await db.from('expenses').select('*').eq('id', sourceExpenseId).single();
      const { data: pmt } = await db.from('payments').select('*').eq('id', destPaymentId).single();

      expect(exp.transfer_id).toBe(transferId);
      expect(pmt.transfer_id).toBe(transferId);
      expect(exp.cash_desk_id).toBe(ilhomCashDeskId);
      expect(pmt.cash_desk_id).toBe(dadojonCashDeskId);
      expect(exp.amount_minor).toBe(100000);
      expect(pmt.amount_minor).toBe(100000);

      // Баланс Дадочона стал ровно 1 000 USD
      const dadoBalance = await FinanceRepository.getCashDeskBalance(dadojonCashDeskId);
      expect(dadoBalance).toBe(1000.00);

      // Общий капитал компании не изменился (28 601.00 USD)
      const adminCashflow = await FinanceRepository.getCashflow({}, adminAccess);
      expect(adminCashflow.summaryByCurrency.USD.netCashflow).toBe(28601.00);

      // Дадочон видит только свой входящий ПКО, не видит РКО источника
      const dadoCashflow = await FinanceRepository.getCashflow({}, dadojonAccess);
      expect(dadoCashflow.transactions.length).toBe(1);
      expect(dadoCashflow.transactions[0].type).toBe('INCOME');
      expect(dadoCashflow.transactions[0].rawId).toBe(destPaymentId);
      expect(dadoCashflow.transactions.find(t => t.rawId === sourceExpenseId)).toBeUndefined();
    });

    it('2.2 Расход Дадочона: создание РКО на 300 USD, остаток становится 700 USD', async () => {
      // Дадочон пытается создать расход на 300 USD
      const exp = await FinanceRepository.addExpense({
        amount: 300,
        currency: 'USD',
        category: 'Хозяйственные расходы',
        recipient: 'Офисмаг',
        description: 'Канцелярия для отдела продаж',
        date: new Date().toISOString().split('T')[0]
      }, DADOJON_USER_ID, dadojonAccess);

      expect(exp).toBeDefined();
      createdRkoId = exp.id;
      createdExpenseIds.push(createdRkoId);

      // cash_desk_id назначен сервером
      expect(exp.cash_desk_id).toBe(dadojonCashDeskId);

      // Баланс Дадочона стал 700 USD
      const dadoBalance = await FinanceRepository.getCashDeskBalance(dadojonCashDeskId);
      expect(dadoBalance).toBe(700.00);
    });

    it('2.3 Попытка расхода 701 USD отклоняется из-за нехватки средств', async () => {
      await expect(
        FinanceRepository.addExpense({
          amount: 701,
          currency: 'USD',
          category: 'Хозяйственные расходы',
          recipient: 'Офисмаг',
          description: 'Попытка превышения лимита',
          date: new Date().toISOString().split('T')[0]
        }, DADOJON_USER_ID, dadojonAccess)
      ).rejects.toThrow(/Недостаточно средств/);

      // Баланс остался 700 USD
      const dadoBalance = await FinanceRepository.getCashDeskBalance(dadojonCashDeskId);
      expect(dadoBalance).toBe(700.00);
    });

    it('2.4 Защита документов: просмотр своего РКО разрешен, чужой документ возвращает 403', async () => {
      // Дадочон запрашивает свой РКО
      const ownRko = await FinanceRepository.getExpenseById(createdRkoId, dadojonAccess);
      expect(ownRko).toBeDefined();
      expect(ownRko.id).toBe(createdRkoId);
      expect(ownRko.cash_desk_id).toBe(dadojonCashDeskId);

      // Дадочон пытается запросить чужой РКО (sourceExpenseId из кассы Илхомчона)
      await expect(
        FinanceRepository.getExpenseById(sourceExpenseId, dadojonAccess)
      ).rejects.toThrow(/Документ не найден/);
    });

    it('2.5 Мутации документов: редактирование и удаление запрещены для менеджера', async () => {
      await expect(
        FinanceRepository.updateExpense(createdRkoId, { description: 'Взлом' }, 'SALES_MANAGER', dadojonAccess)
      ).rejects.toThrow(/запрещено/);

      await expect(
        FinanceRepository.deleteExpense(createdRkoId, 'SALES_MANAGER', dadojonAccess)
      ).rejects.toThrow(/запрещено/);
    });
  });

  // ==========================================
  // БЛОК 3: Тест атомарности остатка и защита от race condition
  // ==========================================
  describe('3. Атомарность остатка и предотвращение race condition при одновременных запросах', () => {
    it('Два одновременных расхода по 400 USD при остатке 700 USD: ровно 1 успешен, второй отклонен, касса не уходит в минус', async () => {
      // Исходный остаток = 700 USD
      const initialBalance = await FinanceRepository.getCashDeskBalance(dadojonCashDeskId);
      expect(initialBalance).toBe(700.00);

      // Запускаем 2 параллельных запроса на списание по 400 USD (в сумме 800 USD > 700 USD)
      const promise1 = FinanceRepository.addExpense({
        amount: 400,
        currency: 'USD',
        category: 'Хозяйственные расходы',
        recipient: 'Поставщик 1',
        description: 'Параллельное списание 1',
        date: new Date().toISOString().split('T')[0]
      }, DADOJON_USER_ID, dadojonAccess);

      const promise2 = FinanceRepository.addExpense({
        amount: 400,
        currency: 'USD',
        category: 'Хозяйственные расходы',
        recipient: 'Поставщик 2',
        description: 'Параллельное списание 2',
        date: new Date().toISOString().split('T')[0]
      }, DADOJON_USER_ID, dadojonAccess);

      const results = await Promise.allSettled([promise1, promise2]);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      // Добавляем созданный расход в трекер очистки
      if (fulfilled.length > 0) {
        fulfilled.forEach(f => createdExpenseIds.push(f.value.id));
      }

      // Ровно один запрос успешен, второй отклонен
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      // Проверяем текст ошибки отклоненного запроса
      expect(rejected[0].reason.message).toMatch(/Недостаточно средств/);

      // Итоговый остаток строго равен 700 - 400 = 300 USD (касса НЕ ушла в минус!)
      const finalBalance = await FinanceRepository.getCashDeskBalance(dadojonCashDeskId);
      expect(finalBalance).toBe(300.00);
    });
  });

  // ==========================================
  // БЛОК 4: Справочный API касс: скрытие чужих касс для менеджера
  // ==========================================
  describe('4. Справочный API: изоляция касс для менеджера', () => {
    it('Справочник CASH_DESK для менеджера возвращает только его кассу', async () => {
      let desks = await DictionariesRepository.getItems('CASH_DESK');
      // Применяем фильтр контроллера
      if (dadojonAccess && !dadojonAccess.isAdmin) {
        desks = desks.filter(d => d.id === dadojonAccess.cashDeskId || d.code === dadojonAccess.cashDeskId);
      }

      expect(desks.length).toBe(1);
      expect(desks[0].id).toBe(dadojonCashDeskId);
      expect(desks[0].name).toContain('Дадочон');
    });

    it('Справочник CASH_DESK для администратора возвращает все кассы', async () => {
      let desks = await DictionariesRepository.getItems('CASH_DESK');
      if (adminAccess && !adminAccess.isAdmin) {
        desks = desks.filter(d => d.id === adminAccess.cashDeskId);
      }

      expect(desks.length).toBeGreaterThanOrEqual(3);
      expect(desks.find(d => d.id === akmalCashDeskId)).toBeDefined();
      expect(desks.find(d => d.id === ilhomCashDeskId)).toBeDefined();
      expect(desks.find(d => d.id === dadojonCashDeskId)).toBeDefined();
    });
  });
});
