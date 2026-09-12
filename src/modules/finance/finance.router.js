import { Router } from 'express';
import { 
  getIncome, 
  getIncomeById,
  addIncome, 
  updateIncome,
  deleteIncome,
  getExpenses, 
  getExpenseById,
  addExpense, 
  updateExpense,
  deleteExpense,
  convertCurrency, 
  getCashflow, 
  getPlanFactReport,
  getEskhataRate,
  createCashTransfer
} from './finance.controller.js';
import { protect } from '../../middleware/auth.middleware.js';
import { 
  resolveCashDeskAccess,
  requireCashDeskMutation,
  requireCashDeskExpense,
  requireCashDeskIncome,
  requireCashTransferPermission
} from '../../middleware/cashDeskAuth.middleware.js';

const router = Router();

// Public rate information
router.get('/rates/eskhata', getEskhataRate);

// All other finance operations require authentication and cash desk authorization
router.use(protect);
router.use(resolveCashDeskAccess);

router.get('/income', getIncome);
router.get('/income/:id', getIncomeById);
router.post('/income', requireCashDeskIncome, addIncome);
router.put('/income/:id', requireCashDeskMutation, updateIncome);
router.patch('/income/:id', requireCashDeskMutation, updateIncome);
router.delete('/income/:id', requireCashDeskMutation, deleteIncome);

router.get('/expenses', getExpenses);
router.get('/expenses/:id', getExpenseById);
router.post('/expenses', requireCashDeskExpense, addExpense);
router.put('/expenses/:id', requireCashDeskMutation, updateExpense);
router.patch('/expenses/:id', requireCashDeskMutation, updateExpense);
router.delete('/expenses/:id', requireCashDeskMutation, deleteExpense);

router.post('/transfers', requireCashTransferPermission, createCashTransfer);
router.post('/convert', requireCashTransferPermission, convertCurrency);
router.get('/cashflow', getCashflow);
router.get('/plan-fact', getPlanFactReport);

export default router;

