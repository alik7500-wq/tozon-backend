import { Router } from 'express';
import { getIncome, getExpenses, addExpense, getCashflow } from './finance.controller.js';

const router = Router();

router.get('/income', getIncome);
router.get('/expenses', getExpenses);
router.post('/expenses', addExpense);
router.get('/cashflow', getCashflow);

export default router;
