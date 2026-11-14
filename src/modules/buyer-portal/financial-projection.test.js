import {it,expect} from 'vitest';
import {projectBuyerContract,creditInContractCurrency} from './financial-projection.js';
const today='2026-11-14';
const payment=(amount,extras={})=>({id:1,status:'ACTIVE',amount_minor:amount,currency:'USD',payment_date:'2026-11-01',operation_type:'STANDARD',settlement_method:'CASH',...extras});
function snapshot(extras={}){return {
  schedules:[{id:1,payment_number:1,due_date:'2026-11-01',amount_minor:40000,status:'UPCOMING'},{id:2,payment_number:2,due_date:'2026-12-01',amount_minor:40000,status:'UPCOMING'}],payments:[payment(40000)],property:{unitNumber:'7'},...extras,deal:{id:1,status:'SIGNED',contract_number:'001',currency:'USD',final_price_minor:100000,down_payment_minor:20000,deal_date:'2026-10-01',payment_type:'INSTALLMENT',...extras.deal}};}
it('matches ledger totals, covers down payment once, then allocates FIFO',()=>{
 const result=projectBuyerContract(snapshot(),today);
 expect(result.summary).toMatchObject({paidMinor:40000,remainingMinor:60000,overdueMinor:20000,downPaymentRemainingMinor:0,nextPayment:{date:'2026-12-01',amountMinor:40000}});
 expect(result.schedules.map(s=>[s.paidMinor,s.remainingMinor,s.status])).toEqual([[20000,20000,'OVERDUE'],[0,40000,'UPCOMING']]);
});
it('does not count planned down payment or agreed barter as received without a posted receipt',()=>{
 const result=projectBuyerContract(snapshot({deal:{barter_amount_minor:20000},payments:[]}),today);
 expect(result.summary).toMatchObject({paidMinor:0,remainingMinor:100000,barterAgreedMinor:20000,barterCreditedMinor:0});
});
it('counts an actual barter once and does not add the agreed amount again',()=>{
 const r=projectBuyerContract(snapshot({deal:{barter_amount_minor:20000},payments:[payment(20000,{settlement_method:'NON_CASH_BARTER'})]}),today);
 expect(r.summary).toMatchObject({paidMinor:20000,barterCreditedMinor:20000,remainingMinor:80000});
});
it('excludes voided/pending receipts and internal movements/conversions/investments from totals',()=>{
 const r=projectBuyerContract(snapshot({payments:[payment(10000),payment(50000,{id:2,status:'VOIDED'}),payment(50000,{id:3,status:'PENDING'}),payment(999999,{id:4,transfer_id:9}),payment(999999,{id:5,conversion_id:9}),payment(999999,{id:6,operation_type:'INVESTMENT'})]}),today);
 expect(r.summary.paidMinor).toBe(10000);expect(r.history).toHaveLength(3);
 expect(r.history.find(p=>p.id===2).creditedMinor).toBeNull();
});
it('preserves split PKO ledger amount instead of doubling it from stale snapshots',()=>{
 const r=projectBuyerContract(snapshot({payments:[payment(150000,{amount_usd:'3000.00',amount_tjs:'28890.00'})]}),today);
 expect(r.summary.paidMinor).toBe(150000);expect(r.summary.overpaidMinor).toBe(50000);
 expect(r.history[0]).toMatchObject({snapshotReviewRequired:true,snapshotUsdMinor:null,snapshotTjsMinor:null});
 expect(r.warnings).toContain('PAYMENT_SNAPSHOT_REVIEW_REQUIRED');
});
it('normalizes mixed currencies with saved values, never a current rate',()=>{
 const r=projectBuyerContract(snapshot({payments:[payment(10000),payment(92600,{id:2,currency:'TJS',amount_usd:'100.00',exchange_rate:'9.26'})]}),today);
 expect(r.summary.paidMinor).toBe(20000);expect(r.history.find(p=>p.id===2)).toMatchObject({amountMinor:92600,currency:'TJS',creditedMinor:10000});
 expect(creditInContractCurrency(payment(92600,{currency:'TJS',exchange_rate:9.26}),'USD')).toBe(10000);
 expect(creditInContractCurrency(payment(10000,{amount_tjs:926}),'TJS')).toBe(92600);
});
it('rounds saved decimal rates exactly, including a half cent and a zero incomplete snapshot',()=>{
 expect(creditInContractCurrency(payment(5,{currency:'TJS',exchange_rate:'2.000000'}),'USD')).toBe(3);
 expect(creditInContractCurrency(payment(92600,{currency:'TJS',amount_usd:'0.00',exchange_rate:'9.26'}),'USD')).toBe(10000);
 expect(creditInContractCurrency(payment(10000,{exchange_rate:'9.630000'}),'TJS')).toBe(96300);
});
it('fails closed for missing FX and contradictory cross-currency snapshots',()=>{
 expect(()=>creditInContractCurrency(payment(10000,{currency:'TJS'}),'USD')).toThrow('BUYER_FINANCE_REVIEW_REQUIRED');
 expect(()=>creditInContractCurrency(payment(150000,{amount_usd:3000,amount_tjs:28890}),'TJS')).toThrow('BUYER_FINANCE_REVIEW_REQUIRED');
});
it('subtracts a real active refund once and reallocates the net paid amount',()=>{
 const r=projectBuyerContract(snapshot({payments:[payment(60000)],refund:{id:4,status:'ACTIVE',currency:'USD',amount_minor:10000,expense_date:today}}),today);
 expect(r.summary).toMatchObject({paidMinor:50000,receivedMinor:60000,refundedMinor:10000,remainingMinor:50000});
 expect(r.schedules[0].paidMinor).toBe(30000);expect(r.history.find(p=>p.kind==='REFUND').creditedMinor).toBe(-10000);
 const voided=projectBuyerContract(snapshot({refund:{id:4,status:'VOIDED',currency:'USD',amount_minor:10000}}),today);
 expect(voided.summary.refundedMinor).toBe(0);
});
it('does not mark debt overdue before the agreed first-payment date',()=>{
 const r=projectBuyerContract(snapshot({deal:{first_payment_date:'2026-12-01'},payments:[]}),today);
 expect(r.summary.overdueMinor).toBe(0);expect(r.schedules.every(s=>s.status==='UPCOMING')).toBe(true);
 expect(r.summary.nextPayment.date).toBe('2026-12-01');
});
it('treats a payment due today as upcoming, not overdue',()=>{
 const r=projectBuyerContract(snapshot({deal:{down_payment_minor:0},schedules:[{id:1,payment_number:1,due_date:today,amount_minor:100000,status:'OVERDUE'}],payments:[]}),today);
 expect(r.summary.overdueMinor).toBe(0);expect(r.schedules[0].status).toBe('UPCOMING');
});
it('flags an incomplete installment plan and never invents schedule rows',()=>{
 const r=projectBuyerContract(snapshot({schedules:[]}),today);expect(r.schedules).toEqual([]);expect(r.warnings).toContain('SCHEDULE_REVIEW_REQUIRED');
 expect(r.summary.overdueMinor).toBeNull();expect(r.summary.nextPayment).toBeNull();
});
it('never invents a due date or overdue amount from the contract signing date',()=>{
 const r=projectBuyerContract(snapshot({deal:{payment_type:'FULL'},schedules:[],payments:[]}),today);
 expect(r.summary.remainingMinor).toBe(100000);expect(r.summary.overdueMinor).toBeNull();expect(r.summary.nextPayment).toBeNull();
});
it('requires review instead of double-subtracting an ambiguous negative payment and a refund expense',()=>{
 expect(()=>projectBuyerContract(snapshot({payments:[payment(60000),payment(-10000,{id:2})],refund:{id:4,status:'ACTIVE',currency:'USD',amount_minor:10000}}),today)).toThrow('BUYER_FINANCE_REVIEW_REQUIRED');
});
it('returns an explicit allowlist, no staff notes, passports, CRM permissions or raw comments',()=>{
 const s=snapshot({property:{unitNumber:'7',passport:'secret'},manager:{name:'Менеджер',email:'private'},payments:[payment(10000,{comment:'PRIVATE [Назначение: Взнос] [Внутреннее: SECRET]'})]});
 s.deal.passport_number='SECRET';s.deal.sales_source='PRIVATE';s.secret='SECRET';
 const r=projectBuyerContract(s,today);expect(JSON.stringify(r)).not.toMatch(/SECRET|PRIVATE|passport|private/);
 expect(r.history[0].purpose).toBe('Взнос');expect(r.manager).toEqual({name:'Менеджер'});
});
it('shows the agreed square-metre rate instead of the current inventory price',()=>{
 const r=projectBuyerContract(snapshot({deal:{price_per_m2_minor:65000},property:{areaM2x100:8180,kind:'APARTMENT'}}),today);
 expect(r.property.pricePerM2Minor).toBe(65000);
});
it('calculates this month from remaining FIFO obligations and the agreed first date',()=>{
 const r=projectBuyerContract(snapshot({deal:{first_payment_date:'2026-11-01'}}),today);
 expect(r.summary.currentMonthDueMinor).toBe(20000);
 const later=projectBuyerContract(snapshot({deal:{first_payment_date:'2026-12-01'}}),today);expect(later.summary.currentMonthDueMinor).toBe(0);
});
it('never invents a monthly total when the schedule or down-payment due date is unknown',()=>{
 expect(projectBuyerContract(snapshot({payments:[]}),today).summary.currentMonthDueMinor).toBeNull();
 expect(projectBuyerContract(snapshot({schedules:[]}),today).summary.currentMonthDueMinor).toBeNull();
});
