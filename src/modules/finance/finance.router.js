import { Router } from 'express';
import { 
  getIncome, 
  addIncome, 
  updateIncome,
  deleteIncome,
  getExpenses, 
  addExpense, 
  updateExpense,
  deleteExpense,
  convertCurrency, 
  getCashflow, 
  getPlanFactReport 
} from './finance.controller.js';

const router = Router();

router.get('/income', getIncome);
router.post('/income', addIncome);
router.put('/income/:id', updateIncome);
router.delete('/income/:id', deleteIncome);

router.get('/expenses', getExpenses);
router.post('/expenses', addExpense);
router.put('/expenses/:id', updateExpense);
router.delete('/expenses/:id', deleteExpense);

router.post('/convert', convertCurrency);
router.get('/cashflow', getCashflow);
router.get('/plan-fact', getPlanFactReport);

export default router;
