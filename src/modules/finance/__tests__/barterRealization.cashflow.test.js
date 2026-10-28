import {it,expect,vi} from 'vitest';
const {db}=vi.hoisted(()=>({db:{from:vi.fn()}}));
vi.mock('../../../db/connection.js',()=>({getDB:()=>db,getServiceDB:()=>db}));
import {FinanceRepository} from '../finance.repository.js';
it('reclassifies only the loss transfer in the complete cashflow report',async()=>{
 const desks=[{id:'barter',name:'Бартер',code:'BARTER'},{id:'result',name:'Результат',code:'BARTER_TMC_REALIZATION'},{id:'cash',name:'Наличные',code:'MAIN_CASHIER'}];
 const tables={dictionaries:desks,payments:[{id:549,cash_desk_id:'barter',amount_minor:1081081,currency:'USD',payment_date:'2026-10-24',status:'ACTIVE'},{id:571,cash_desk_id:'cash',amount_minor:918919,currency:'USD',payment_date:'2026-10-28',status:'ACTIVE'},{id:572,cash_desk_id:'result',amount_minor:162162,currency:'USD',payment_date:'2026-10-28',status:'ACTIVE'}],expenses:[{id:915,cash_desk_id:'barter',amount_minor:918919,currency:'USD',expense_date:'2026-10-28',status:'ACTIVE'},{id:916,cash_desk_id:'barter',amount_minor:162162,currency:'USD',expense_date:'2026-10-28',status:'ACTIVE'}],barter_realization_results:[{source_cash_desk_id:'barter',result_cash_desk_id:'result',source_currency:'USD',reclassified_payment_id:572,reclassified_expense_id:916,result_tjs_minor:-1500000,result_usd_minor:-162162,cost_tjs_minor:10000000,proceeds_tjs_minor:8500000,selling_cost_tjs_minor:0,asset_name:'Genesis'}]};
 db.from.mockImplementation(table=>{const q={select:()=>q,eq:()=>q,order:()=>q,then:resolve=>resolve({data:tables[table]||[],error:null})};return q});
 vi.spyOn(FinanceRepository,'getAvailableYears').mockResolvedValue([2026]);
 const r=await FinanceRepository.getCashflow({year:2026},{isAdmin:true});
 expect(r.cashDesksSummary.find(d=>d.name==='Результат')).toMatchObject({balanceUsd:-1621.62,balanceTjs:-15000,isAnalytical:true});
 expect(r.cashDesksSummary.find(d=>d.name==='Бартер').balanceUsd).toBe(0);
 expect(r.cashDesksSummary.find(d=>d.name==='Наличные').balanceUsd).toBe(9189.19);
 expect(r.summaryByCurrency.USD.netCashflow).toBe(9189.19);
 expect(r.transactions.some(t=>t.rawId===572 || t.rawId===916)).toBe(false);
 expect(r.transactions.some(t=>t.rawId===571)).toBe(true);
});
