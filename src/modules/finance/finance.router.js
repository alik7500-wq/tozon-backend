import { Router } from 'express';
import { getIncome, addIncome, getExpenses, addExpense, getCashflow } from './finance.controller.js';

const router = Router();

router.get('/income', getIncome);
router.post('/income', addIncome);
router.get('/expenses', getExpenses);
router.post('/expenses', addExpense);
router.get('/cashflow', getCashflow);

export default router;
