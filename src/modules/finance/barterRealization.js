// Signed analytical result. Never add this account to available money/cash capital.
export const BARTER_RESULT_CODE = 'BARTER_TMC_REALIZATION';
export function excludeReclassifiedTransfers(payments, expenses, results) {
 const paymentIds=new Set(results.map(r=>Number(r.reclassified_payment_id)));
 const expenseIds=new Set(results.map(r=>Number(r.reclassified_expense_id)));
 return {payments:payments.filter(p=>!paymentIds.has(Number(p.id))),expenses:expenses.filter(e=>!expenseIds.has(Number(e.id)))};
}
export function applyBarterResults(map,desks,results) {
 const byId=new Map(desks.map(d=>[String(d.id),d]));
 for(const desk of desks) if(desk.code===BARTER_RESULT_CODE && map[desk.name]) {
  Object.assign(map[desk.name],{USD:0,TJS:0,RUB:0,isAnalytical:true,resultDetails:[]});
 }
 for(const r of results) {
  const source=byId.get(String(r.source_cash_desk_id)), result=byId.get(String(r.result_cash_desk_id));
  const usd=Number(r.result_usd_minor)/100,tjs=Number(r.result_tjs_minor)/100;
  // Close the unsold barter asset difference, without inventing a cash expense.
  if(source && map[source.name]) {
   map[source.name][r.source_currency]=Math.round(map[source.name][r.source_currency]*100+Number(r.source_currency==='USD'?r.result_usd_minor:r.result_tjs_minor))/100;
   const key=r.source_currency==='USD'?'nonCashAdjustmentUsd':'nonCashAdjustmentTjs';
   map[source.name][key]=(map[source.name][key] || 0)+(r.source_currency==='USD'?usd:tjs);
  }
  if(result && map[result.name]) {
   const target=map[result.name];target.isAnalytical=true;target.USD+=usd;target.TJS+=tjs;
   target.resultDetails.push({asset:r.asset_name,date:r.realization_date,costTjs:Number(r.cost_tjs_minor)/100,proceedsTjs:Number(r.proceeds_tjs_minor)/100,sellingCostTjs:Number(r.selling_cost_tjs_minor)/100,resultTjs:tjs,resultUsd:usd});
  }
 }
}
