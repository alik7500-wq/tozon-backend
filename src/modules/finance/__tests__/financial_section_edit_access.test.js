import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../../db/connection.js',()=>({getDB:vi.fn(),getServiceDB:vi.fn()}));
import { getDB, getServiceDB } from '../../../db/connection.js';
import { FinanceRepository } from '../finance.repository.js';
import { resolveCashDeskAccess, requireCashDeskIncome, requireCashDeskExpense, requireCashDeskMutation } from '../../../middleware/cashDeskAuth.middleware.js';
import { authorizeSectionRequest } from '../../../middleware/sectionAccess.js';
const desk='11111111-1111-4111-8111-111111111111';
const foreign='22222222-2222-4222-8222-222222222222';
const profile=permissions=>({id:4,role:'FINANCE_MANAGER',permissions:['access.v2','finance.restricted',...permissions]});
const grants=['finance.payments','finance.payments.write','finance.expenses','finance.expenses.write','finance.view','finance.debtors','finance.cashflow'];
const access={matrixPermissions:true,allWritableDesks:false,isAdmin:false,canEditIncome:true,canEditExpense:true,editableIncomeDeskIds:[desk],editableExpenseDeskIds:[desk]};
let record,payload,rpc;
beforeEach(()=>{
 vi.restoreAllMocks();
 record={id:700,cash_desk_id:desk,amount_minor:10000,currency:'TJS',operation_type:'STANDARD'};payload=undefined;
 const db={from:table=>{
  let writing=false;
  const q={select:()=>q,eq:()=>q,update:data=>{writing=true;payload=data;return q},maybeSingle:async()=>({data:table==='dictionaries'?{id:foreign}:record}),then:resolve=>resolve({data:writing?[{...record,...payload}]:[{cash_desk_id:desk,can_view:true,can_create_expense:true,can_create_income:false},{cash_desk_id:foreign,can_view:true,can_create_income:false,can_create_expense:false}]})};return q;
 }};
 getDB.mockReturnValue(db);
 rpc=vi.fn(async(_,args)=>({data:{payment:{...record,...args.p_payment_update}},error:null}));getServiceDB.mockReturnValue({rpc});
 vi.spyOn(FinanceRepository,'syncPairedConversion').mockResolvedValue();
});
describe('financial matrix: creation and editing, scoped to assigned desks',()=>{
 it('enables assigned-desk PKO and RKO when admin granted both write permissions',async()=>{
  const req={user:profile(grants),method:'POST',originalUrl:'/api/finance/income',query:{},body:{cash_desk_id:desk}};
  const next=vi.fn();await resolveCashDeskAccess(req,{},next);expect(next).toHaveBeenCalledWith();
  expect(req.cashDeskAccess.incomeDeskIds).toEqual([desk]);expect(req.cashDeskAccess.editableExpenseDeskIds).toEqual([desk]);
  for(const guard of [requireCashDeskIncome,requireCashDeskExpense]){const check=vi.fn();guard(req,{},check);expect(check).toHaveBeenCalledWith();}
  req.body.cash_desk_id=foreign;const denied=vi.fn();requireCashDeskIncome(req,{},denied);expect(denied.mock.calls[0][0].statusCode).toBe(403);
 });
 it('read-only permissions do not allow creation or editing',async()=>{
  const req={user:profile(['finance.payments','finance.expenses']),method:'PATCH',originalUrl:'/api/finance/income/700',query:{},body:{}};
  await resolveCashDeskAccess(req,{},vi.fn());expect(req.cashDeskAccess.canCreateIncome).toBe(false);expect(req.cashDeskAccess.canEditIncome).toBe(false);
  const denied=vi.fn();requireCashDeskMutation(req,{},denied);expect(denied.mock.calls[0][0].statusCode).toBe(403);
 });
 it('deletion is not part of the write checkbox',()=>{
  const next=vi.fn();requireCashDeskMutation({user:profile(grants),method:'DELETE',cashDeskAccess:access},{},next);expect(next.mock.calls[0][0].statusCode).toBe(403);
 });
 it('cashflow remains read-only and auto-conversion cannot bypass it',async()=>{
  const base={user:profile(grants),method:'POST',query:{}};
  await expect(authorizeSectionRequest({...base,originalUrl:'/api/finance/convert',body:{}})).rejects.toMatchObject({statusCode:403});
  await expect(authorizeSectionRequest({...base,originalUrl:'/api/finance/expenses',body:{auto_convert:true}})).rejects.toMatchObject({statusCode:403});
 });
 for(const type of ['Income','Expense']){
  it(`permits ${type} editing with scope and keeps the original update mechanism`,async()=>{
   const result=await FinanceRepository['update'+type](700,{amount:'150.00'},'FINANCE_MANAGER',access);
   expect(result.amount_minor).toBe(15000);if(type==='Income')expect(rpc).toHaveBeenCalledOnce();else expect(payload.amount_minor).toBe(15000);
  });
  it(`denies ${type} editing of another desk`,async()=>{
   record.cash_desk_id=foreign;
   await expect(FinanceRepository['update'+type](700,{amount:150},'FINANCE_MANAGER',access)).rejects.toMatchObject({statusCode:403});expect(rpc).not.toHaveBeenCalled();expect(payload).toBeUndefined();
  });
  it(`denies ${type} reassignment to another desk`,async()=>{
   await expect(FinanceRepository['update'+type](700,{cash_desk_id:foreign},'FINANCE_MANAGER',access)).rejects.toMatchObject({statusCode:403});expect(rpc).not.toHaveBeenCalled();expect(payload).toBeUndefined();
  });
  it(`denies editing paired conversion ${type} records without administrative access`,async()=>{
   record.operation_type='CONVERSION';
   await expect(FinanceRepository['update'+type](700,{comment:'Changed'},'FINANCE_MANAGER',access)).rejects.toMatchObject({statusCode:403});
  });
 }
});
