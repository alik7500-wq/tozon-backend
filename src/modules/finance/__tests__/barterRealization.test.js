import {describe,it,expect} from 'vitest';
import {excludeReclassifiedTransfers,applyBarterResults} from '../barterRealization.js';
const desks=[{id:'source',name:'Бартер'},{id:'result',name:'Результат',code:'BARTER_TMC_REALIZATION'},{id:'cash',name:'Наличные'}];
const row={source_cash_desk_id:'source',result_cash_desk_id:'result',source_currency:'USD',result_tjs_minor:-1500000,result_usd_minor:-162162,reclassified_payment_id:572,reclassified_expense_id:916,cost_tjs_minor:10000000,proceeds_tjs_minor:8500000,selling_cost_tjs_minor:0,asset_name:'Hyundai Genesis',realization_date:'2026-10-28'};
describe('non-cash barter realization',()=>{
 it('reclassifies only the evidenced technical transfer, preserving actual sale and purchase',()=>{
  const r=excludeReclassifiedTransfers([{id:549},{id:571},{id:572}],[{id:915},{id:916}], [row]);
  expect(r).toEqual({payments:[{id:549},{id:571}],expenses:[{id:915}]});
 });
 it('shows negative result, closes residual asset and excludes result from money totals',()=>{
  const map={'Бартер':{USD:1621.62,TJS:0},'Результат':{USD:0,TJS:0},'Наличные':{USD:9189.19,TJS:0}};
  applyBarterResults(map,desks,[row]);
  expect(map['Бартер'].USD).toBe(0);
  expect(map['Результат']).toMatchObject({USD:-1621.62,TJS:-15000,isAnalytical:true});
  expect(map['Результат'].resultDetails[0]).toMatchObject({costTjs:100000,proceedsTjs:85000,resultTjs:-15000});
  expect(Object.values(map).filter(d=>!d.isAnalytical).reduce((sum,d)=>sum+d.USD,0)).toBe(9189.19);
 });
 it('does not reveal result or another asset desk when absent from permitted desks',()=>{
  const map={'Наличные':{USD:9189.19,TJS:0}};applyBarterResults(map,[desks[2]],[row]);expect(Object.keys(map)).toEqual(['Наличные']);
 });
});
