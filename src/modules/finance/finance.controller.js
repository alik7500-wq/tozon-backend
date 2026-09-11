import { FinanceRepository } from './finance.repository.js';
import { AppError } from '../../shared/errors/errorHandler.js';

export const getIncome = async (req, res, next) => {
  try {
    const filters = req.query || {};
    const data = await FinanceRepository.getIncome(filters, req.cashDeskAccess);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching income:', error);
    next(error);
  }
};

export const getIncomeById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const data = await FinanceRepository.getIncomeById(id, req.cashDeskAccess);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const addIncome = async (req, res, next) => {
  try {
    const incomeData = req.body;
    const userId = req.user.id;
    const data = await FinanceRepository.addIncome(incomeData, userId, req.cashDeskAccess);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error adding income:', error);
    next(error);
  }
};

export const updateIncome = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userRole = req.user.role;
    const data = await FinanceRepository.updateIncome(id, req.body, userRole, req.cashDeskAccess);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error updating income:', error);
    next(error);
  }
};

export const deleteIncome = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userRole = req.user.role;
    const data = await FinanceRepository.deleteIncome(id, userRole, req.cashDeskAccess);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error deleting income:', error);
    next(error);
  }
};

export const getExpenses = async (req, res, next) => {
  try {
    const filters = req.query || {};
    const data = await FinanceRepository.getExpenses(filters, req.cashDeskAccess);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching expenses:', error);
    next(error);
  }
};

export const getExpenseById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const data = await FinanceRepository.getExpenseById(id, req.cashDeskAccess);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const addExpense = async (req, res, next) => {
  try {
    const expenseData = req.body;
    if (!expenseData.idempotency_key || !String(expenseData.idempotency_key).trim()) {
      throw new AppError('idempotency_key обязателен для создания финансовой операции', 400);
    }
    const userId = req.user.id;
    const data = await FinanceRepository.addExpense(expenseData, userId, req.cashDeskAccess);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error adding expense:', error);
    next(error);
  }
};

export const updateExpense = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userRole = req.user.role;
    const data = await FinanceRepository.updateExpense(id, req.body, userRole, req.cashDeskAccess);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error updating expense:', error);
    next(error);
  }
};

export const deleteExpense = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userRole = req.user.role;
    const data = await FinanceRepository.deleteExpense(id, userRole, req.cashDeskAccess);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error deleting expense:', error);
    next(error);
  }
};

export const convertCurrency = async (req, res, next) => {
  try {
    if (!req.cashDeskAccess?.isAdmin) {
      throw new AppError('Конвертация валют доступна только администраторам', 403);
    }
    const convertData = req.body;
    const userId = req.user.id;
    const data = await FinanceRepository.convertCurrency(convertData, userId);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error converting currency:', error);
    next(error);
  }
};

export const getCashflow = async (req, res, next) => {
  try {
    const filters = req.query || {};
    const data = await FinanceRepository.getCashflow(filters, req.cashDeskAccess);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching cashflow:', error);
    next(error);
  }
};

export const getPlanFactReport = async (req, res, next) => {
  try {
    const filters = req.query || {};
    const data = await FinanceRepository.getPlanFactReport(filters, req.cashDeskAccess);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching plan-fact report:', error);
    next(error);
  }
};

export const getEskhataRate = async (req, res) => {
  try {
    const { EskhataRateService } = await import('./eskhata-rate.service.js');
    const data = await EskhataRateService.getEskhataUsdRate();
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching Eskhata rate:', error);
    res.json({
      success: true,
      data: {
        bank: 'Банк Эсхата',
        currency: 'USD',
        baseCurrency: 'TJS',
        buyRate: 9.18,
        sellRate: 9.27,
        source: 'Банк Эсхата (Продажа USD)',
        updatedAt: new Date().toISOString()
      }
    });
  }
};

export const createCashTransfer = async (req, res, next) => {
  try {
    if (!req.cashDeskAccess?.isAdmin) {
      throw new AppError('Перемещения между кассами доступны только администраторам', 403);
    }
    const transferData = req.body;
    const userId = req.user.id;
    const data = await FinanceRepository.createCashTransfer(transferData, userId);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error creating cash transfer:', error);
    next(error);
  }
};

