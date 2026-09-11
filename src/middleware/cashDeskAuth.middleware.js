import { getDB } from '../db/connection.js';
import { AppError } from '../shared/errors/errorHandler.js';

/**
 * Middleware для контроля кассового доступа
 * Ограничивает менеджеров только их персональной кассой
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
        cashDeskId: null,
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

    // Загрузка прав из user_cash_desk_access
    let accessRecord = null;
    try {
      const { data, error } = await db
        .from('user_cash_desk_access')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

      if (!error && data) {
        accessRecord = data;
      }
    } catch {
      // Таблица может еще не существовать до применения миграции
    }

    // Если записи нет, но это менеджер Дадочон (id: 3, role: SALES_MANAGER),
    // используем гарантированный безопасный профиль прав по справочнику
    if (!accessRecord && (user.id === 3 || user.email === 'manager1@tozon.tj')) {
      const { data: desk } = await db
        .from('dictionaries')
        .select('id')
        .eq('code', 'SALES_MANAGER_Dadojon')
        .eq('type', 'CASH_DESK')
        .maybeSingle();

      if (desk) {
        accessRecord = {
          user_id: user.id,
          cash_desk_id: desk.id,
          can_view: true,
          can_create_income: true,
          can_create_expense: true,
          can_edit: false,
          can_void: false,
          can_delete: false,
        };
      }
    }

    if (!accessRecord || !accessRecord.can_view) {
      return next(new AppError('У вас нет прав доступа к кассовым операциям', 403));
    }

    req.cashDeskAccess = {
      isAdmin: false,
      allDesks: false,
      cashDeskId: accessRecord.cash_desk_id,
      canView: Boolean(accessRecord.can_view),
      canCreateIncome: Boolean(accessRecord.can_create_income),
      canCreateExpense: Boolean(accessRecord.can_create_expense),
      canEdit: Boolean(accessRecord.can_edit),
      canVoid: Boolean(accessRecord.can_void),
      canDelete: Boolean(accessRecord.can_delete),
      accessRecord
    };

    // Если клиент пытается передать в запросе cash_desk_id другой кассы — отклоняем
    const requestedDesk = req.query.cash_desk_id || req.body?.cash_desk_id;
    if (requestedDesk && requestedDesk !== req.cashDeskAccess.cashDeskId) {
      return next(new AppError('Доступ к чужой кассе запрещен', 403));
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
  if (req.cashDeskAccess?.isAdmin || req.cashDeskAccess?.canCreateExpense) {
    return next();
  }
  return next(new AppError('У вас нет прав на оформление расходов из кассы', 403));
};

/**
 * Проверка права на создание прихода (ПКО)
 */
export const requireCashDeskIncome = (req, res, next) => {
  if (req.cashDeskAccess?.isAdmin || req.cashDeskAccess?.canCreateIncome) {
    return next();
  }
  return next(new AppError('У вас нет прав на оформление приходов в кассу', 403));
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
