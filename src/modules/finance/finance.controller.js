import { FinanceRepository } from './finance.repository.js';

export const getIncome = async (req, res) => {
  try {
    const filters = req.query || {};
    const data = await FinanceRepository.getIncome(filters);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching income:', error);
    res.status(500).json({ success: false, error: { message: error.message || 'Failed to fetch income' } });
  }
};

export const addIncome = async (req, res) => {
  try {
    const incomeData = req.body;
    const userId = req.user?.id;
    const data = await FinanceRepository.addIncome(incomeData, userId);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error adding income:', error);
    res.status(500).json({ success: false, error: { message: error.message || 'Failed to add income' } });
  }
};

export const updateIncome = async (req, res) => {
  try {
    const { id } = req.params;
    const userRole = req.user?.role || req.body?.userRole || 'ADMIN';
    const data = await FinanceRepository.updateIncome(id, req.body, userRole);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error updating income:', error);
    res.status(500).json({ success: false, error: { message: error.message || 'Failed to update income' } });
  }
};

export const deleteIncome = async (req, res) => {
  try {
    const { id } = req.params;
    const userRole = req.user?.role || req.body?.userRole || 'ADMIN';
    const data = await FinanceRepository.deleteIncome(id, userRole);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error deleting income:', error);
    res.status(500).json({ success: false, error: { message: error.message || 'Failed to delete income' } });
  }
};

export const getExpenses = async (req, res) => {
  try {
    const filters = req.query || {};
    const data = await FinanceRepository.getExpenses(filters);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching expenses:', error);
    res.status(500).json({ success: false, error: { message: error.message || 'Failed to fetch expenses' } });
  }
};

export const addExpense = async (req, res) => {
  try {
    const expenseData = req.body;
    const userId = req.user?.id;
    const data = await FinanceRepository.addExpense(expenseData, userId);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error adding expense:', error);
    res.status(500).json({ success: false, error: { message: error.message || 'Failed to add expense' } });
  }
};

export const updateExpense = async (req, res) => {
  try {
    const { id } = req.params;
    const userRole = req.user?.role || req.body?.userRole || 'ADMIN';
    const data = await FinanceRepository.updateExpense(id, req.body, userRole);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error updating expense:', error);
    res.status(500).json({ success: false, error: { message: error.message || 'Failed to update expense' } });
  }
};

export const deleteExpense = async (req, res) => {
  try {
    const { id } = req.params;
    const userRole = req.user?.role || req.body?.userRole || 'ADMIN';
    const data = await FinanceRepository.deleteExpense(id, userRole);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error deleting expense:', error);
    res.status(500).json({ success: false, error: { message: error.message || 'Failed to delete expense' } });
  }
};

export const convertCurrency = async (req, res) => {
  try {
    const convertData = req.body;
    const userId = req.user?.id;
    const data = await FinanceRepository.convertCurrency(convertData, userId);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error converting currency:', error);
    res.status(500).json({ success: false, error: { message: error.message || 'Failed to convert currency' } });
  }
};

export const getCashflow = async (req, res) => {
  try {
    const filters = req.query || {};
    const data = await FinanceRepository.getCashflow(filters);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching cashflow:', error);
    res.status(500).json({ success: false, error: { message: error.message || 'Failed to fetch cashflow' } });
  }
};

export const getPlanFactReport = async (req, res) => {
  try {
    const filters = req.query || {};
    const data = await FinanceRepository.getPlanFactReport(filters);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching plan-fact report:', error);
    res.status(500).json({ success: false, error: { message: error.message || 'Failed to fetch plan-fact report' } });
  }
};
