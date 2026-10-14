import { getDB } from '../db/connection.js';
import { hasSection, isMatrixUser } from './sectionAccess.js';
import { AppError } from '../shared/errors/errorHandler.js';

/**
 * Middleware для контроля кассового доступа
 * Поддерживает множественные кассы пользователя с разграничением прав view/income/expense
 */
export const resolveCashDeskAccess = async (req, res, next) => {
  try {
    const user = req.user;
    if (!user) {
      req.cashDeskAccess = null;
      return next();
    }

    const matrixPermissions = isMatrixUser(user);
    const canWriteIncome = matrixPermissions && hasSection(user, 'finance.payments', true);
    const canWriteExpense = matrixPermissions && hasSection(user, 'finance.expenses', true);

    // Администратор, Директор и Финансовый менеджер имеют полный доступ ко всем кассам компании
    if (user.role === 'ADMIN' || user.role === 'DIRECTOR' || (user.role === 'FINANCE_MANAGER' && !user.permissions?.includes('finance.restricted'))) {
      req.cashDeskAccess = {
        isAdmin: true,
        allDesks: true,
        userId: user.id,
        cashDeskId: null,
        viewableDeskIds: [],
        incomeDeskIds: [],
        expenseDeskIds: [],
        canView: true,
        canCreateIncome: !matrixPermissions || canWriteIncome,
        canCreateExpense: !matrixPermissions || canWriteExpense,
        matrixPermissions,
        allWritableDesks: true,
        canEditIncome: matrixPermissions ? canWriteIncome : user.role === 'ADMIN',
        canEditExpense: matrixPermissions ? canWriteExpense : user.role === 'ADMIN',
        editableIncomeDeskIds: [],
        editableExpenseDeskIds: [],
        canEdit: user.role === 'ADMIN' || user.role === 'FINANCE_MANAGER',
        canVoid: user.role === 'ADMIN',
        canDelete: user.role === 'ADMIN',
      };
      return next();
    }

    const db = getDB();

    // Загрузка всех прав пользователя из user_cash_desk_access
    let accessRecords = [];
    try {
      const { data, error } = await db
        .from('user_cash_desk_access')
        .select('*')
        .eq('user_id', user.id);

      if (!error && Array.isArray(data)) {
        accessRecords = data;
      }
    } catch {
      // Таблица может еще не существовать до применения миграции
    }

    // Если записей нет или только 1 касса, но это менеджер Дадочон (id: 3, role: SALES_MANAGER),
    // гарантируем безопасный профиль прав по ТЗ (касса Дадочона + прием в кассы Акмалхона и Илхомчона)
    if ((accessRecords.length === 0 || accessRecords.length === 1) && (user.id === 3 || user.email === 'manager1@tozon.tj')) {
      const { data: desks } = await db
        .from('dictionaries')
        .select('id, code')
        .eq('type', 'CASH_DESK');

      const dadoDesk = desks?.find(d => d.code === 'SALES_MANAGER_Dadojon');
      const akmalDesk = desks?.find(d => d.code === 'SALES_MANAGER');
      const ilhomDesk = desks?.find(d => d.code === 'MAIN_CASHIER');

      const baseRecords = [];
      if (dadoDesk) {
        baseRecords.push({
          user_id: user.id,
          cash_desk_id: dadoDesk.id,
          can_view: true,
          can_create_income: true,
          can_create_expense: true,
          can_edit: false,
          can_void: false,
          can_delete: false,
        });
      }
      if (akmalDesk) {
        baseRecords.push({
          user_id: user.id,
          cash_desk_id: akmalDesk.id,
          can_view: false,
          can_create_income: true,
          can_create_expense: false,
          can_edit: false,
          can_void: false,
          can_delete: false,
        });
      }
      if (ilhomDesk) {
        baseRecords.push({
          user_id: user.id,
          cash_desk_id: ilhomDesk.id,
          can_view: false,
          can_create_income: true,
          can_create_expense: false,
          can_edit: false,
          can_void: false,
          can_delete: false,
        });
      }

      // Мержим записи: приоритет за базовыми разрешениями ТЗ
      const mergedMap = new Map();
      baseRecords.forEach(r => mergedMap.set(r.cash_desk_id, r));
      accessRecords.forEach(r => {
        if (mergedMap.has(r.cash_desk_id)) {
          mergedMap.set(r.cash_desk_id, { ...mergedMap.get(r.cash_desk_id), ...r });
        } else {
          mergedMap.set(r.cash_desk_id, r);
        }
      });
      accessRecords = Array.from(mergedMap.values());
    }

    const viewableDeskIds = accessRecords.filter(r => r.can_view).map(r => r.cash_desk_id);
    let incomeDeskIds = accessRecords.filter(r => r.can_create_income).map(r => r.cash_desk_id);
    const expenseDeskIds = accessRecords.filter(r => r.can_create_expense).map(r => r.cash_desk_id);

    if (viewableDeskIds.length === 0 && incomeDeskIds.length === 0 && expenseDeskIds.length === 0) {
      return next(new AppError('У вас нет прав доступа к кассовым операциям', 403));
    }

    const primaryDeskId = user.permissions?.includes('finance.restricted')
      ? (expenseDeskIds[0] || viewableDeskIds[0] || null)
      : (viewableDeskIds[0] || expenseDeskIds[0] || incomeDeskIds[0] || null);

    // A saved matrix controls operations, while desk assignments control where they can occur.
    if (matrixPermissions && user.permissions?.includes('finance.restricted') && canWriteIncome && !incomeDeskIds.length && primaryDeskId) incomeDeskIds = [primaryDeskId];
    const editableIncomeDeskIds = incomeDeskIds.filter(id => viewableDeskIds.includes(id));
    const editableExpenseDeskIds = expenseDeskIds.filter(id => viewableDeskIds.includes(id));

    req.cashDeskAccess = {
      matrixPermissions,
      allWritableDesks: false,
      canEditIncome: matrixPermissions && canWriteIncome && editableIncomeDeskIds.length > 0,
      canEditExpense: matrixPermissions && canWriteExpense && editableExpenseDeskIds.length > 0,
      editableIncomeDeskIds,
      editableExpenseDeskIds,
      userId: user.id,
      isAdmin: Boolean(user.permissions?.includes('finance.restricted') && ['GET', 'HEAD'].includes(req.method)),
      allDesks: Boolean(user.permissions?.includes('finance.restricted') && ['GET', 'HEAD'].includes(req.method)),
      cashDeskId: primaryDeskId,
      viewableDeskIds,
      incomeDeskIds,
      expenseDeskIds,
      canView: viewableDeskIds.length > 0,
      canCreateIncome: incomeDeskIds.length > 0 && (!matrixPermissions || canWriteIncome),
      canCreateExpense: expenseDeskIds.length > 0 && (!matrixPermissions || canWriteExpense),
      canEdit: matrixPermissions ? (canWriteIncome && editableIncomeDeskIds.length > 0) || (canWriteExpense && editableExpenseDeskIds.length > 0) : accessRecords.some(r => r.can_edit),
      canVoid: accessRecords.some(r => r.can_void),
      canDelete: accessRecords.some(r => r.can_delete),
      accessRecords
    };

    // Валидация кассы в параметрах GET-запроса (просмотр)
    const requestedViewDesk = req.query.cash_desk_id;
    if (requestedViewDesk && requestedViewDesk !== 'ALL' && !viewableDeskIds.includes(requestedViewDesk)) {
      return next(new AppError('Доступ к просмотру чужой кассы запрещен', 403));
    }

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Запрет на любые изменения, аннулирования и удаления проведенных документов для менеджеров
 */
export const requireCashDeskMutation = (req, res, next) => {
  if (req.cashDeskAccess?.matrixPermissions && req.user?.role !== 'ADMIN') {
    const access = req.cashDeskAccess;
    if (req.method === 'DELETE') return next(new AppError('Право добавления и редактирования не разрешает удаление ордеров', 403));
    const income = /\/income(?:\/|$)/.test(String(req.originalUrl || ''));
    if (!(income ? access.canEditIncome : access.canEditExpense)) return next(new AppError('Нет права редактирования ордера', 403));
    return next();
  }
  if (req.cashDeskAccess?.isAdmin || req.cashDeskAccess?.canEdit) {
    return next();
  }
  return next(new AppError('Редактирование, аннулирование или удаление проведенных кассовых документов запрещено для вашей роли', 403));
};

/**
 * Проверка права на создание расхода (РКО)
 */
export const requireCashDeskExpense = (req, res, next) => {
  if (req.cashDeskAccess?.isAdmin) {
    return next();
  }
  if (!req.cashDeskAccess?.canCreateExpense || req.cashDeskAccess.expenseDeskIds.length === 0) {
    return next(new AppError('У вас нет прав на оформление расходов из кассы', 403));
  }
  const targetDesk = req.body?.cash_desk_id;
  if (targetDesk && !req.cashDeskAccess.expenseDeskIds.includes(targetDesk)) {
    return next(new AppError('Оформление расхода из выбранной кассы запрещено для вашей роли', 403));
  }
  next();
};

/**
 * Проверка права на создание прихода (ПКО)
 */
export const requireCashDeskIncome = (req, res, next) => {
  if (req.cashDeskAccess?.isAdmin) {
    return next();
  }
  if (!req.cashDeskAccess?.canCreateIncome || req.cashDeskAccess.incomeDeskIds.length === 0) {
    return next(new AppError('У вас нет прав на оформление приходов в кассу', 403));
  }
  const targetDesk = req.body?.cash_desk_id;
  if (targetDesk && !req.cashDeskAccess.incomeDeskIds.includes(targetDesk)) {
    return next(new AppError('Зачисление прихода в выбранную кассу запрещено для вашей роли', 403));
  }
  next();
};

/**
 * Запрет на создание перемещений между кассами для обычных менеджеров
 */
export const requireCashTransferPermission = (req, res, next) => {
  if (req.cashDeskAccess?.isAdmin) {
    return next();
  }
  return next(new AppError('Операции перемещения средств между кассами доступны только администраторам', 403));
};

