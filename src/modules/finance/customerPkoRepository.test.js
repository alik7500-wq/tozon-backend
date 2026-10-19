import {vi,describe,it,expect,beforeEach} from 'vitest';
const mocks=vi.hoisted(()=>({rows:[],desks:[{id:'desk-a',name:'Касса А'},{id:'desk-b',name:'Касса Б'}]}));
vi.mock('../../db/connection.js',()=>{
 const db={from:table=>({select:()=>table==='payments'?{order:async()=>({data:mocks.rows,error:null})}:{in:async()=>({data:mocks.desks,error:null})}})};
 return {getDB:()=>db,getServiceDB:()=>db};
});
import {FinanceRepository} from './finance.repository.js';
beforeEach(()=>{
 vi.spyOn(FinanceRepository,'getAvailableYears').mockResolvedValue([2026]);
 mocks.rows=[
  {id:1,deal_id:1,reference:'ПКО-98',document_number:'ПКО-98',customer_pko_number:98,amount_minor:10000,currency:'USD',payment_date:'2026-10-19',cash_desk_id:'desk-a',status:'ACTIVE',deals:{contract_number:'0045',units:{unit_number:'7',unit_kind:'APARTMENT',floors:{floor_number:2,sections:{buildings:{name:'Блок Б'}}}}}},
  {id:2,deal_id:2,reference:'ПКО-97',amount_minor:20000,currency:'USD',payment_date:'2026-10-18',cash_desk_id:'desk-b',status:'ACTIVE'},
  {id:3,deal_id:1,reference:'ПКО-96',amount_minor:50000,currency:'USD',payment_date:'2026-10-17',cash_desk_id:'desk-a',status:'VOIDED'},
  {id:4,reference:'ПКО-КОНВ-99',amount_minor:100000,currency:'USD',payment_date:'2026-10-19',operation_type:'CONVERSION',status:'ACTIVE'},
  {id:5,reference:'INV-1',amount_minor:90000,currency:'USD',payment_date:'2026-10-19',operation_type:'INVESTMENT',status:'ACTIVE'}
 ];
});
describe('customer book uses existing cash access and financial semantics',()=>{
 it('includes voided customer receipts for audit, excludes them from totals and excludes investments/conversions',async()=>{
  const r=await FinanceRepository.getIncome({year:'ALL',customer_book:'1',include_voided:'1'},{isAdmin:true});
  expect(r.list.map(p=>p.id)).toEqual([1,2,3]);expect(r.totalsByCurrency.USD).toBe(300);
  expect(r.list[0]).toMatchObject({document_number:'ПКО-98',cashDeskName:'Касса А',property:'Блок Б · Квартира №7 · этаж 2'});
 });
 it('keeps cash-desk access isolation for book and export data',async()=>{
  const r=await FinanceRepository.getIncome({year:'ALL',customer_book:'1',include_voided:'1'},{isAdmin:false,viewableDeskIds:['desk-a']});
  expect(r.list.map(p=>p.id)).toEqual([1,3]);expect(r.totalsByCurrency.USD).toBe(100);
  const forbidden=await FinanceRepository.getIncome({year:'ALL',customer_book:'1',cash_desk_id:'desk-b'},{isAdmin:false,viewableDeskIds:['desk-a']});
  expect(forbidden.list).toEqual([]);
 });
 it('applies date/search filters consistently to book rows and totals',async()=>{
  const r=await FinanceRepository.getIncome({year:'ALL',customer_book:'1',include_voided:'1',search:'ПКО-98',date_from:'2026-10-18'},{isAdmin:true});
  expect(r.list.map(p=>p.id)).toEqual([1]);expect(r.totalsByCurrency.USD).toBe(100);
 });
 it('retains noncustomer numbering and rows in the general journal',async()=>{
  const r=await FinanceRepository.getIncome({year:'ALL'},{isAdmin:true});
  expect(r.list.find(p=>p.id===4).reference).toBe('ПКО-КОНВ-99');expect(r.list.find(p=>p.id===5).reference).toBe('INV-1');
 });
});
