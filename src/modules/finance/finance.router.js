import { getServiceDB } from '../../db/connection.js';
import { Router } from 'express';
import { 
  getIncome, 
  exportCustomerPkoBook,
  getIncomeById,
  addIncome, 
  updateIncome,
  reconcileIncomeTjs,
  reconcileIncomeTjsBulk,
  deleteIncome,
  getExpenses, getRkoRegistrationBook, exportRkoRegistrationBook,
  getExpenseById,
  addExpense, 
  updateExpense,
  deleteExpense,
  convertCurrency, 
  getCashflow, 
  exportCashflowExcel,
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

import paymentCalendarRouter from './payment_calendar.router.js';

const router = Router();

// Public rate information
router.get('/rates/eskhata', getEskhataRate);

// All other finance operations require authentication and cash desk authorization
router.use(protect);
router.use(resolveCashDeskAccess);

router.get('/access', (req, res) => {
  const a = req.cashDeskAccess || {};
  res.json({ status: 'success', data: { cashAccess: {
    allWritableDesks: Boolean(a.allWritableDesks),
    incomeDeskIds: a.incomeDeskIds || [], expenseDeskIds: a.expenseDeskIds || [],
    editableIncomeDeskIds: a.editableIncomeDeskIds || [], editableExpenseDeskIds: a.editableExpenseDeskIds || [],
    canCreateIncome: Boolean(a.canCreateIncome), canCreateExpense: Boolean(a.canCreateExpense),
    canEditIncome: Boolean(a.canEditIncome), canEditExpense: Boolean(a.canEditExpense),
    canDelete: req.user.role === 'ADMIN' && Boolean(a.canDelete), primaryDeskId: a.cashDeskId
  } } });
});

router.use(paymentCalendarRouter);

router.get('/income', getIncome);
router.get('/income/customer-book.xlsx', exportCustomerPkoBook);
router.post('/income/reconcile-tjs/bulk', reconcileIncomeTjsBulk);
router.get('/income/:id', getIncomeById);
router.post('/income', requireCashDeskIncome, addIncome);
router.post('/income/:id/reconcile-tjs', reconcileIncomeTjs);
router.put('/income/:id', requireCashDeskMutation, updateIncome);
router.patch('/income/:id', requireCashDeskMutation, updateIncome);
router.delete('/income/:id', requireCashDeskMutation, deleteIncome);

router.get('/settlement-parties', async(req,res,next)=>{
 try{
  const access=req.cashDeskAccess;
  if(!access?.isAdmin&&!access?.canCreateExpense&&!access?.canEditExpense){res.status(403).json({message:'Нет права оформления РКО'});return;}
  const {data,error}=await getServiceDB().from('construction_parties').select('id,name,kind,active').neq('kind','EMPLOYEE').order('name');
  if(error)throw error;
  res.json({status:'success',data:{parties:data}});
 }catch(e){next(e);}
});
router.get('/expenses', getExpenses);
router.get('/expenses/book', getRkoRegistrationBook);
router.get('/expenses/book.xlsx', exportRkoRegistrationBook);
router.get('/expenses/:id', getExpenseById);
router.post('/expenses', requireCashDeskExpense, addExpense);
router.put('/expenses/:id', requireCashDeskMutation, updateExpense);
router.patch('/expenses/:id', requireCashDeskMutation, updateExpense);
router.delete('/expenses/:id', requireCashDeskMutation, deleteExpense);

router.post('/transfers', requireCashTransferPermission, createCashTransfer);
router.post('/convert', requireCashTransferPermission, convertCurrency);
router.get('/cashflow/export.xlsx', exportCashflowExcel);
router.get('/cashflow/export', exportCashflowExcel);
router.get('/cashflow', getCashflow);
router.get('/plan-fact', getPlanFactReport);

export default router;


