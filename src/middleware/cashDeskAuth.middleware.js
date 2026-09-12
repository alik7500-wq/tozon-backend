import { getDB } from '../db/connection.js';
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

    // Администратор, Директор и Финансовый менеджер имеют полный доступ ко всем кассам компании
    if (user.role === 'ADMIN' || user.role === 'DIRECTOR' || user.role === 'FINANCE_MANAGER') {
      req.cashDeskAccess = {
        isAdmin: true,
        allDesks: true,
        userId: user.id,
        cashDeskId: null,
        viewableDeskIds: [],
        incomeDeskIds: [],
        expenseDeskIds: [],
        canView: true,
        canCreateIncome: true,
        canCreateExpense: true,
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
    const incomeDeskIds = accessRecords.filter(r => r.can_create_income).map(r => r.cash_desk_id);
    const expenseDeskIds = accessRecords.filter(r => r.can_create_expense).map(r => r.cash_desk_id);

    if (viewableDeskIds.length === 0 && incomeDeskIds.length === 0 && expenseDeskIds.length === 0) {
      return next(new AppError('У вас нет прав доступа к кассовым операциям', 403));
    }

    const primaryDeskId = viewableDeskIds[0] || expenseDeskIds[0] || incomeDeskIds[0] || null;

    req.cashDeskAccess = {
      userId: user.id,
      isAdmin: false,
      allDesks: false,
      cashDeskId: primaryDeskId,
      viewableDeskIds,
      incomeDeskIds,
      expenseDeskIds,
      canView: viewableDeskIds.length > 0,
      canCreateIncome: incomeDeskIds.length > 0,
      canCreateExpense: expenseDeskIds.length > 0,
      canEdit: accessRecords.some(r => r.can_edit),
      canVoid: accessRecords.some(r => r.can_void),
      canDelete: accessRecords.some(r => r.can_delete),
      accessRecords
    };

    // Валидация кассы в параметрах GET-запроса (просмотр)
    const requestedViewDesk = req.query.cash_desk_id;
    if (requestedViewDesk && !viewableDeskIds.includes(requestedViewDesk)) {
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
