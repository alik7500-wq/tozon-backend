import { Router } from 'express';
import { 
  getIncome, 
  addIncome, 
  getExpenses, 
  addExpense, 
  convertCurrency, 
  getCashflow, 
  getPlanFactReport 
} from './finance.controller.js';

const router = Router();

router.get('/income', getIncome);
router.post('/income', addIncome);
router.get('/expenses', getExpenses);
router.post('/expenses', addExpense);
router.post('/convert', convertCurrency);
router.get('/cashflow', getCashflow);
router.get('/plan-fact', getPlanFactReport);

export default router;
