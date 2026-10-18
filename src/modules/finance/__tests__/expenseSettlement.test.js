import {describe,it,expect,vi,beforeEach} from 'vitest';
const db=vi.hoisted(()=>({from:vi.fn(),rpc:vi.fn()}));
vi.mock('../../../db/connection.js',()=>({getDB:()=>db,getServiceDB:()=>db}));
import {FinanceRepository} from '../finance.repository.js';
import {expenseSettlement,settlementCashDocuments,settlementCashEntries} from '../expenseSettlement.js';
const party='550e8400-e29b-41d4-a716-446655440000';
const desk='ab90800a-73af-4cf7-88c2-397c304e2edf';
const payload={amount:'100',currency:'TJS',date:'2026-10-02',exchange_rate:10,idempotency_key:'EXP-linked',cash_desk_id:desk,settlement_party_id:party,settlement_account:'PAYABLE'};
beforeEach(()=>vi.clearAllMocks());
describe('Expense settlement integration',()=>{
 it('validates paired fields and permits explicit removal',()=>{
  expect(expenseSettlement({})).toBeNull();
  expect(()=>expenseSettlement({settlement_party_id:party})).toThrow('контрагента');
  expect(expenseSettlement({settlement_party_id:null,settlement_account:null},{settlement_party_id:party,settlement_account:'PAYABLE'})).toEqual({settlement_party_id:null,settlement_account:null});
 });
 it('uses transactional RPC and server cash-desk scope for a linked RKO',async()=>{
  db.rpc.mockResolvedValue({data:{id:100}});
  const r=await FinanceRepository.addExpense(payload,2,{isAdmin:false,cashDeskId:desk});
  expect(r.id).toBe(100);expect(db.rpc).toHaveBeenCalledWith('create_expense_with_settlement',expect.objectContaining({p_actor:2,p_data:expect.objectContaining({cash_desk_id:desk,amount:100,currency:'TJS',settlement_party_id:party})}));
  expect(db.from).not.toHaveBeenCalled();
 });
 it('never falls back to unlinked cash after a settlement failure',async()=>{
  db.rpc.mockResolvedValue({error:{message:'Контрагент неактивен'}});
  await expect(FinanceRepository.addExpense(payload,1,{isAdmin:true})).rejects.toThrow('неактивен');expect(db.from).not.toHaveBeenCalled();
 });
 it('rejects incomplete links before any cash write',async()=>{
  await expect(FinanceRepository.addExpense({...payload,settlement_account:null},1,{isAdmin:true})).rejects.toThrow('контрагента');expect(db.rpc).not.toHaveBeenCalled();
 });
 it('atomically edits amount and link and refreshes historical currency snapshots',async()=>{
  const original={id:100,amount_minor:10000,currency:'TJS',exchange_rate:10,settlement_party_id:party,settlement_account:'PAYABLE',cash_desk_id:desk,created_by_user_id:1};
  const update=vi.fn().mockReturnValue({eq:()=>({select:async()=>({data:[original]})})});
  db.from.mockReturnValue({select:()=>({eq:()=>({maybeSingle:async()=>({data:original})})}),update});
  await FinanceRepository.updateExpense(100,{amount:150,settlement_party_id:party,settlement_account:'PAYABLE'},'ADMIN',{isAdmin:true,userId:1});
  expect(update).toHaveBeenCalledWith(expect.objectContaining({amount_minor:15000,amount_tjs:150,amount_usd:15,settlement_party_id:party,settlement_updated_by:1}));
 });
 it('retains cash edit restrictions for users without mutation permission',async()=>{
  await expect(FinanceRepository.updateExpense(100,{settlement_party_id:party},'SALES_MANAGER',{isAdmin:false})).rejects.toThrow('запрещено');expect(db.from).not.toHaveBeenCalled();
 });
 it('normalizes automatic RKO into period-aware construction movements without altering values',()=>{
  const rows=[{id:100,party_id:party,doc_date:'2026-10-02',currency:'TJS',account:'PAYABLE',amount:'-100.00'}];
  expect(settlementCashEntries(rows)[0]).toMatchObject({document_id:'expense:100',amount:'-100.00'});
  expect(settlementCashDocuments(rows)[0]).toMatchObject({id:'expense:100',expense_id:100,doc_date:'2026-10-02',amount:100,automatic_expense:true});
 });
});
