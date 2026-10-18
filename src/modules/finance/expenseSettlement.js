import { z } from 'zod';
import { AppError } from '../../shared/errors/errorHandler.js';
const fields=z.object({settlement_party_id:z.string().uuid().nullable(),settlement_account:z.enum(['PAYABLE','ADVANCE_GIVEN','RECEIVABLE','ADVANCE_RECEIVED']).nullable()}).strict().refine(v=>Boolean(v.settlement_party_id)===Boolean(v.settlement_account),'Выберите контрагента и назначение расчёта');
export function expenseSettlement(data,original=null){
 const requested=Object.hasOwn(data,'settlement_party_id')||Object.hasOwn(data,'settlement_account');
 if(!requested)return null;
 const r=fields.safeParse({settlement_party_id:data.settlement_party_id??original?.settlement_party_id??null,settlement_account:data.settlement_account??original?.settlement_account??null});
 // Explicit null removes both sides; do not silently preserve a stale account.
 if(data.settlement_party_id===null&&data.settlement_account===null)return {settlement_party_id:null,settlement_account:null};
 if(!r.success)throw new AppError(r.error.issues.map(i=>i.message).join('; '),400);
 return r.data;
}
export function settlementCashDocuments(rows){
 return rows.map(e=>({id:`expense:${e.id}`,number:e.id,kind:'SETTLEMENT_PAYMENT',status:'POSTED',doc_date:e.doc_date,currency:e.currency,party_id:e.party_id,
  amount:Math.abs(Number(e.amount)),balance_type:e.account,expense_id:e.id,basis:e.description||'Автоматический расчёт по РКО',lines:[],automatic_expense:true,
  created_by:e.created_by_user_id,created_at:e.created_at}));
}
export function settlementCashEntries(rows){return rows.map(e=>({id:`expense:${e.id}`,document_id:`expense:${e.id}`,party_id:e.party_id,currency:e.currency,account:e.account,amount:e.amount}));}
