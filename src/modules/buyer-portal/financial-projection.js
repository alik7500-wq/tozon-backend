import {allocatePaymentsFIFO,getDushanbeCurrentDateStr} from '../../utils/fifoPaymentAllocation.js';

const active=p=>['ACTIVE','POSTED'].includes(p.status);
const currencies=new Set(['USD','TJS']);
const check=value=>{const n=Number(value);if(!Number.isSafeInteger(n))throw new Error('BUYER_FINANCE_REVIEW_REQUIRED');return n;};
const decimal=value=>{
  const match=/^(\d+)(?:\.(\d{1,12}))?$/.exec(String(value));
  if(!match)throw new Error('BUYER_FINANCE_REVIEW_REQUIRED');
  return {n:BigInt(match[1]+(match[2]||'')),d:10n**BigInt((match[2]||'').length)};
};
const rounded=(n,d)=>{const sign=n<0n?-1n:1n,abs=n*sign;return check(Number(sign*((abs+d/2n)/d)));};
const minor=value=>{if(value===null||value===undefined||value==='')return null;const v=decimal(value);return rounded(v.n*100n,v.d);};
const sum=values=>values.reduce((a,b)=>check(a+b),0);
const customerPayment=p=>['STANDARD','INCOME','DEAL_PAYMENT'].includes(p.operation_type||'STANDARD')
  && !p.transfer_id&&!p.conversion_id&&!['INTERNAL_TRANSFER','CONVERSION'].includes(p.settlement_method);

/** Same-currency ledger is authoritative; snapshots must never replace a split/moved PKO. */
export function creditInContractCurrency(payment,currency){
  const source=payment.currency||currency;
  if(!currencies.has(source)||!currencies.has(currency))throw new Error('BUYER_FINANCE_REVIEW_REQUIRED');
  const ledger=check(payment.amount_minor);
  if(source===currency)return ledger;
  const ownSnapshot=minor(source==='USD'?payment.amount_usd:payment.amount_tjs);
  if(ownSnapshot!==null&&ownSnapshot!==ledger)throw new Error('BUYER_FINANCE_REVIEW_REQUIRED');
  const targetSnapshot=minor(currency==='USD'?payment.amount_usd:payment.amount_tjs);
  if(targetSnapshot!==null&&(targetSnapshot>0||ledger===0))return targetSnapshot;
  const rate=decimal(payment.exchange_rate);
  if(rate.n===0n)throw new Error('BUYER_FINANCE_REVIEW_REQUIRED');
  return currency==='USD'?rounded(BigInt(ledger)*rate.d,rate.n):rounded(BigInt(ledger)*rate.n,rate.d);
}

function receipt(payment,currency){
  const source=payment.currency||currency,ledger=check(payment.amount_minor);
  const own=minor(source==='USD'?payment.amount_usd:payment.amount_tjs);
  const mismatch=own!==null&&own!==ledger;
  const method=['CASH','BANK','BANK_TRANSFER','CARD','NON_CASH_BARTER','TRANSFER'].includes(payment.settlement_method)
    ?payment.settlement_method:['CASH','BANK','BANK_TRANSFER','CARD'].includes(payment.method)?payment.method:'OTHER';
  return {id:payment.id,kind:'PAYMENT',date:payment.payment_date,amountMinor:ledger,currency:source,
    creditedMinor:active(payment)?creditInContractCurrency(payment,currency):null,
    number:payment.customer_pko_number?`ПКО-${payment.customer_pko_number}`:payment.document_number||payment.reference||null,
    method,status:payment.status,
    purpose:/\[Назначение:\s*([^\]]{1,300})\]/i.exec(payment.comment||'')?.[1]?.trim()||null,
    snapshotReviewRequired:mismatch,
    snapshotUsdMinor:mismatch?null:minor(payment.amount_usd),snapshotTjsMinor:mismatch?null:minor(payment.amount_tjs)};
}

/** Input is one authorized database snapshot. Never return raw CRM rows. */
export function projectBuyerContract(snapshot,today=getDushanbeCurrentDateStr()){
  const d=snapshot.deal,currency=d.currency;
  if(!currencies.has(currency))throw new Error('BUYER_FINANCE_REVIEW_REQUIRED');
  const total=check(d.final_price_minor),down=check(d.down_payment_minor||0);
  if(total<0||down<0||down>total)throw new Error('BUYER_FINANCE_REVIEW_REQUIRED');
  const payments=(snapshot.payments||[]).filter(customerPayment);
  const counted=payments.filter(active);
  const received=sum(counted.map(p=>creditInContractCurrency(p,currency)));
  const refund=snapshot.refund;
  const refunded=refund&&active(refund)?creditInContractCurrency(refund,currency):0;
  if(refunded>0&&counted.some(p=>check(p.amount_minor)<0))throw new Error('BUYER_FINANCE_REVIEW_REQUIRED');
  const paid=check(received-refunded);
  if(paid<0)throw new Error('BUYER_FINANCE_REVIEW_REQUIRED');
  // FIFO consumes the net, normalized pool; no synthetic receipt is persisted or displayed.
  const fifo=allocatePaymentsFIFO(snapshot.schedules||[],[{id:0,status:'ACTIVE',amount_minor:paid,payment_date:today}],down,today);
  const beforeStart=Boolean(d.first_payment_date&&today<d.first_payment_date);
  const schedules=fifo.schedules.map(s=>({id:s.id,number:s.payment_number,dueDate:s.due_date,
    plannedMinor:check(s.amount_minor),paidMinor:s.paid_amount_minor,remainingMinor:s.remaining_amount_minor,
    status:s.remaining_amount_minor===0?'PAID':!beforeStart&&s.due_date<today?'OVERDUE':s.paid_amount_minor>0?'PARTIAL':'UPCOMING'}));
  const remaining=Math.max(0,total-paid),downRemaining=Math.max(0,down-Math.min(down,paid));
  let overdue=sum(schedules.filter(s=>s.status==='OVERDUE').map(s=>s.remainingMinor));
  const unpaid=schedules.filter(s=>s.remainingMinor>0);
  const scheduleReview=['INSTALLMENT','PARTIAL_BARTER'].includes(d.payment_type)&&sum(schedules.map(s=>s.plannedMinor))!==total-down;
  let next=unpaid.find(s=>s.dueDate>=today)||unpaid[0];
  let nextPayment=next?{date:beforeStart&&next.dueDate<d.first_payment_date?d.first_payment_date:next.dueDate,amountMinor:next.remainingMinor}:null;
  if(!schedules.length&&remaining>0&&d.first_payment_date){nextPayment={date:d.first_payment_date,amountMinor:remaining};if(!beforeStart&&nextPayment.date<today)overdue=remaining;}
  const unknownDueDate=!schedules.length&&remaining>0&&!d.first_payment_date;
  const history=payments.map(p=>receipt(p,currency));
  if(refund)history.push({id:refund.id,kind:'REFUND',date:refund.expense_date,number:refund.reference||null,
    amountMinor:check(refund.amount_minor),currency:refund.currency||currency,creditedMinor:active(refund)?-refunded:null,status:refund.status,method:'REFUND'});
  history.sort((a,b)=>String(b.date).localeCompare(String(a.date))||Number(b.id)-Number(a.id));
  const warnings=[];
  if(history.some(p=>p.snapshotReviewRequired))warnings.push('PAYMENT_SNAPSHOT_REVIEW_REQUIRED');
  if(scheduleReview)warnings.push('SCHEDULE_REVIEW_REQUIRED');
  return {id:d.id,contractNumber:d.contract_number,contractDate:d.deal_date,status:d.status,
    property:Object.fromEntries(['projectName','buildingName','sectionName','floorNumber','unitNumber','kind','areaM2x100','rooms'].map(key=>[key,snapshot.property?.[key]??null])),manager:snapshot.manager?{name:snapshot.manager.name}:null,
    summary:{currency,totalMinor:total,paidMinor:paid,receivedMinor:received,refundedMinor:refunded,remainingMinor:remaining,
      overpaidMinor:Math.max(0,paid-total),overdueMinor:remaining===0?0:scheduleReview||unknownDueDate?null:Math.min(remaining,overdue),downPaymentMinor:down,
      downPaymentRemainingMinor:downRemaining,barterAgreedMinor:check(d.barter_amount_minor||0),
      barterCreditedMinor:sum(counted.filter(p=>p.settlement_method==='NON_CASH_BARTER').map(p=>creditInContractCurrency(p,currency))),
      firstPaymentDate:d.first_payment_date,nextPayment:remaining>0&&!scheduleReview?nextPayment:null},history,schedules,warnings,asOf:today};
}
