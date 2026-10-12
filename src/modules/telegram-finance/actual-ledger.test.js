import {it,expect,vi} from 'vitest';
vi.mock('../../db/connection.js',()=>({getServiceDB:vi.fn()}));
import {TelegramFinanceRepository} from './repository.js';
import {actualOperation,expenseAmounts,formatExpense,buildReport,renderReport} from './report.js';
it('hides both exchange legs while retaining the linked actual expense',()=>{
 expect(actualOperation({id:1,reference:'ПКО-КОНВ-504',conversion_id:'group',status:'ACTIVE'},'income')).toBe(false);
 expect(actualOperation({id:2,category:'Конвертация валюты',status:'ACTIVE'},'expense')).toBe(false);
 expect(actualOperation({id:3,category:'Строительные материалы',conversion_id:'group',conversion_expense_id:2,status:'ACTIVE'},'expense')).toBe(true);
 expect(actualOperation({id:4,status:'VOIDED'},'expense')).toBe(false);
 expect(actualOperation({id:5,transfer_id:'transfer',status:'ACTIVE'},'expense')).toBe(false);
});
it('uses original amounts and historical metadata/rates for TJS and USD',()=>{
 expect(expenseAmounts({currency:'TJS',amount_minor:92700,amount_usd:100,exchange_rate:9.27})).toEqual({TJS:92700,USD:10000});
 expect(expenseAmounts({currency:'TJS',amount_minor:92700,exchange_rate:9.27})).toEqual({TJS:92700,USD:10000});
 expect(expenseAmounts({currency:'USD',amount_minor:10000,amount_tjs:927,exchange_rate:9.26})).toEqual({USD:10000,TJS:92700});
 expect(expenseAmounts({currency:'USD',amount_minor:10000,description:'Расход • 1 500 TJS (Курс: 15)'})).toEqual({USD:10000,TJS:150000});
 expect(expenseAmounts({currency:'USD',amount_minor:10000,exchange_rate:9.27})).toEqual({USD:10000,TJS:92700});
 expect(formatExpense({currency:'USD',amount_minor:10000})).toContain('TJS: курс не указан');
});
it('filters before pagination and preserves exact cash scope on every query',async()=>{
 const raw=Array.from({length:130},(_,id)=>({id,currency:'TJS',amount_minor:100,status:'ACTIVE',reference:id%2===0?'КОНВ-'+id:'РКО-'+id}));
 const filters=[];const db={from:()=>{const q={select:()=>q,eq:(key,value)=>{filters.push([key,value]);return q;},order:()=>q,range:async(a,b)=>({data:raw.slice(a,b+1),error:null})};return q;}};
 const repo=new TelegramFinanceRepository(db);const u={slot:'ILHOM',status:'APPROVED',cash_desk_id:'own'};
 expect((await repo.ledger(u,'expense','own',0)).map(r=>r.id)).toEqual([1,3,5,7,9,11,13,15,17,19]);
 expect((await repo.ledger(u,'expense','own',50)).map(r=>r.id)).toEqual([101,103,105,107,109,111,113,115,117,119]);
 expect(filters.every(([key,value])=>key==='cash_desk_id'&&value==='own')).toBe(true);
 await expect(repo.ledger(u,'expense','other')).rejects.toThrow('CASH_ACCESS_DENIED');
});
it('renders detail reports with the same dual amounts as the RKO ledger',()=>{
 const s={desks:[],payments:[],deals:[],expenses:[{id:1,status:'ACTIVE',currency:'TJS',amount_minor:92700,amount_usd:100,expense_date:'2026-10-12',category:'Материалы'}]};
 const r=buildReport(s,'2026-10-12','2026-10-12',new Date('2026-10-12T12:00Z'));
 const text=renderReport(r,'details','OWNER');expect(text).toContain('927,00 TJS');expect(text).toContain('100,00 USD');
});
