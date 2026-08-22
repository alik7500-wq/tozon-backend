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
