import { z } from 'zod';
import { getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';
const id=z.number().int().positive().max(2147483647),uuid=z.uuid(),date=z.iso.date();
const amount=id, rate=z.number().positive().max(100000).optional();
const currency=z.enum(['USD','TJS']);
const baseMoney={cash_desk_id:uuid,amount_minor:amount,currency,exchange_rate:rate,date};
const line=z.object({material_id:uuid,quantity:z.number().positive().max(1e9).refine(n=>Math.abs(n*10000-Math.round(n*10000))<1e-5,'Количество: до четырёх знаков'),value:z.number().nonnegative().max(1e12).refine(n=>Math.abs(n*100-Math.round(n*100))<1e-5,'Стоимость: до двух знаков').optional()}).strict();
export const commandSchema=z.discriminatedUnion('kind',[
 z.object({request_id:uuid,kind:z.literal('CANCEL_DRAFT'),payload:z.object({deal_id:id,expected_updated_at:z.string().min(1).max(100),reason:z.string().trim().min(5).max(1000)}).strict()}).strict(),
 z.object({request_id:uuid,kind:z.literal('TERMINATE_UNPAID'),payload:z.object({deal_id:id,expected_updated_at:z.string().min(1).max(100),reason:z.string().trim().min(5).max(1000),basis:z.string().trim().min(3).max(500),basis_date:date}).strict()}).strict(),
 z.object({request_id:uuid,kind:z.literal('SIGN_DEAL'),payload:z.object({deal_id:id,expected_updated_at:z.string().min(1).max(100),scheme_id:uuid.optional(),scheme_updated_at:z.string().min(1).max(100).optional(),rule_key:z.string().min(1).max(300).optional(),down_payment_minor:z.number().int().nonnegative().max(2147483647),installment_months:z.number().int().min(0).max(120),first_payment_date:date.optional()}).strict()}).strict(),
 z.object({request_id:uuid,kind:z.literal('DEAL_DRAFT'),payload:z.object({lead_id:id,unit_id:id,final_price_minor:amount,down_payment_minor:z.number().int().nonnegative().max(2147483647).default(0),payment_type:z.enum(['FULL','INSTALLMENT']).default('FULL'),installment_months:z.number().int().min(0).max(120).default(0),date}).strict()}).strict(),
 z.object({request_id:uuid,kind:z.literal('PAYMENT'),payload:z.object({...baseMoney,deal_id:id,comment:z.string().trim().max(1000).default('')}).strict()}).strict(),
 z.object({request_id:uuid,kind:z.literal('EXPENSE'),payload:z.object({...baseMoney,category:z.string().trim().min(1).max(200),recipient:z.string().trim().max(200).default(''),description:z.string().trim().max(1000).default(''),settlement_party_id:uuid.optional(),settlement_account:z.enum(['PAYABLE','ADVANCE_GIVEN','RECEIVABLE','ADVANCE_RECEIVED']).optional()}).strict()}).strict(),
 z.object({request_id:uuid,kind:z.literal('STOCK_POST'),payload:z.object({kind:z.enum(['RECEIPT','ISSUE','TRANSFER','RETURN_STOCK','WRITE_OFF']),date,currency,warehouse_id:uuid,destination_id:uuid.optional(),party_id:uuid.optional(),complex_id:id.optional(),work_type:z.string().trim().max(500).optional(),basis:z.string().trim().min(1).max(3000),lines:z.array(line).min(1).max(200)}).strict()}).strict(),
]);
export function parseWorkspaceCommand(body){
 const result=commandSchema.safeParse(body);
 if(!result.success)throw new AppError(result.error.issues.map(i=>i.message).join('; '),400);
 return result.data;
}
export async function executeWorkspaceCommand(actor,project,command){
 const {data,error}=await getServiceDB().rpc('execute_company_project_command',{p_actor:actor,p_project:project,p_request:command.request_id,p_kind:command.kind,p_payload:command.payload});
 if(error){
  if(String(error.message).includes('CLOSURE_FINANCIAL_REVIEW_REQUIRED'))throw new AppError('Есть денежные движения, бартер или оплаченный график. Нужна отдельная процедура расчёта и возврата; простое закрытие запрещено.',409);
  if(String(error.message).includes('TERMINATION_BASIS_REQUIRED'))throw new AppError('Укажите основание и дату расторжения: не раньше договора и не позже сегодняшней даты.',400);
  if(String(error.message).includes('STALE_CLOSURE_TARGET'))throw new AppError('Договор изменился или уже закрыт. Обновите список и проверьте его состояние.',409);
  if(error.code==='42501')throw new AppError('Нет права на эту операцию в выбранном проекте',403);
  if(error.code==='P0002')throw new AppError('Связанная запись не найдена в выбранном проекте',404);
  if(['23505','40001'].includes(error.code))throw new AppError('Операция уже выполнена с другими данными либо объект занят',409);
  if(['22023','23514','23503','22P02','22007','22008'].includes(error.code))throw new AppError('Проверьте данные, валюту и принадлежность всех записей выбранному проекту',400);
  if(String(error.message).includes('INSUFFICIENT_FUNDS'))throw new AppError('Недостаточно средств в выбранной кассе',409);
  if(error.code==='P0001')throw new AppError('Операция не проведена: проверьте остатки и условия документа',409);
  throw error;
 }
 return data;
}
