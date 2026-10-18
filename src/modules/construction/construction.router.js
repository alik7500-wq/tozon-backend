import { Router } from 'express';
import { z } from 'zod';
import { getServiceDB } from '../../db/connection.js';
import { protect } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { can, TYPES, permissionFor } from './access.js';

const router = Router();
const checked = r => { if (r.error) throw new AppError(r.error.message, ['23505','40001'].includes(r.error.code) ? 409 : r.error.code === '42501' ? 403 : 400); return r.data; };
const allowed = (user,p) => { if (!can(user,p)) throw new AppError('Недостаточно прав доступа',403); };
const uuid = z.string().uuid();
const nullableId = uuid.nullable().optional();
const date = z.iso.date();
const money = z.coerce.number().positive().max(999999999999).refine(n=>Math.abs(n*100-Math.round(n*100))<0.0001,'До двух знаков после запятой');
const line = z.object({material_id:uuid.optional(),quantity:z.coerce.number().positive().optional(),value:z.coerce.number().nonnegative().optional(),amount:money.optional(),basis:z.string().max(2000).optional(),proof:z.string().max(2000).optional(),receipt_id:nullableId}).strict();
const schema = z.object({id:uuid,kind:z.enum(TYPES),doc_date:date,due_date:date.nullable().optional(),currency:z.enum(['TJS','USD']),exchange_rate:z.coerce.number().positive().nullable().optional(),warehouse_id:nullableId,destination_id:nullableId,party_id:nullableId,project_id:z.coerce.number().int().positive().nullable().optional(),work_type:z.string().max(500).nullable().optional(),basis:z.string().trim().min(1).max(3000),balance_type:z.enum(['RECEIVABLE','PAYABLE','ADVANCE_GIVEN','ADVANCE_RECEIVED']).nullable().optional(),amount:money.nullable().optional(),lines:z.array(line).max(200).default([]),expense_id:z.coerce.number().int().positive().nullable().optional(),payment_id:z.coerce.number().int().positive().nullable().optional()}).strict();
const parse = (schema,input) => { const r=schema.safeParse(input); if(!r.success)throw new AppError(r.error.issues.map(x=>`${x.path.join('.')}: ${x.message}`).join('; '),400);return r.data; };
const wrap = fn => async(req,res,next)=>{try{await fn(req,res);}catch(e){next(e);}};
router.use(protect);
router.use((req,res,next)=>{if(['construction.stock','construction.advance','construction.settlements','construction.settings'].some(p=>can(req.user,p)))next();else next(new AppError('Нет доступа к строительному учёту',403));});
const all = async (db,table) => {
 const data=[];
 for(let offset=0;;offset+=500){const rows=checked(await db.from(table).select('*').order('id').range(offset,offset+499));data.push(...rows);if(rows.length<500)return data;}
};
router.get('/state',wrap(async(req,res)=>{
 const db=getServiceDB(); const user=req.user;
 const [settings,parties,warehouses,materials,documents,stock,settlements,projects,corrections] = await Promise.all(['construction_settings','construction_parties','construction_warehouses','construction_materials','construction_documents','construction_stock_entries','construction_settlement_entries','projects','construction_price_corrections'].map(t=>all(db,t)));
 const own=parties.filter(p=>p.user_id===user.id).map(p=>p.id);
 const finance=can(user,'construction.settlements');
 const cfg=settings[0];
 const approver=cfg?.approver_user_id===user.id;
 const filtered=documents.filter(d=>can(user,permissionFor(d.kind)) && (!d.kind.includes('ADVANCE') || finance || approver || own.includes(d.party_id)));
 for(const d of filtered){const history=corrections.filter(c=>c.receipt_id===d.id).sort((a,b)=>a.version-b.version);d.price_corrections=history.map(({ledger_changes,...c})=>c);d.price_version=history.at(-1)?.version||0;if(history.length)d.lines=history.at(-1).after_lines;}
 const visible=new Set(filtered.map(d=>d.id));
 const users=can(user,'construction.settings')?checked(await db.from('users').select('id,name,is_active').order('name')).filter(u=>u.is_active===true||u.is_active===1).map(({id,name})=>({id,name})):[];
 res.json({status:'success',data:{settings:cfg,parties:finance||approver?parties:parties.filter(p=>p.kind!=='EMPLOYEE'||own.includes(p.id)),warehouses,materials,documents:filtered.sort((a,b)=>b.number-a.number),stock:can(user,'construction.stock')?stock:[],settlements:settlements.filter(s=>visible.has(s.document_id)),projects:projects.map(p=>({id:p.id,name:p.name})),users,permissions:{stock:can(user,'construction.stock'),advance:can(user,'construction.advance'),settlements:finance,settings:can(user,'construction.settings'),approve:approver,correct_prices:can(user,'construction.settings')}}});
}));
const masters={warehouses:z.object({name:z.string().trim().min(1).max(200),responsible_id:nullableId,active:z.boolean().optional()}).strict(),materials:z.object({name:z.string().trim().min(1).max(200),unit:z.string().trim().min(1).max(30),category:z.string().max(100).nullable().optional(),active:z.boolean().optional()}).strict(),parties:z.object({name:z.string().trim().min(1).max(200),kind:z.enum(['SUPPLIER','CONTRACTOR','DEBTOR','EMPLOYEE']),user_id:z.number().int().positive().nullable().optional(),active:z.boolean().optional()}).strict()};
router.post('/masters/:type',wrap(async(req,res)=>{
 const type=req.params.type; if(!masters[type])throw new AppError('Справочник не найден',404);
 allowed(req.user,'construction.settings');const body=parse(masters[type],req.body);
 res.status(201).json({data:checked(await getServiceDB().from(`construction_${type}`).insert(body).select().single())});
}));
router.patch('/masters/:type/:id',wrap(async(req,res)=>{
 const type=req.params.type;if(!masters[type])throw new AppError('Справочник не найден',404);
 allowed(req.user,'construction.settings');const body=parse(masters[type].partial(),req.body);
 res.json({data:checked(await getServiceDB().from(`construction_${type}`).update(body).eq('id',parse(uuid,req.params.id)).select().single())});
}));
router.patch('/settings',wrap(async(req,res)=>{
 allowed(req.user,'construction.settings');
 const body=parse(z.object({approver_user_id:z.number().int().positive()}).strict(),req.body);
 res.json({data:checked(await getServiceDB().from('construction_settings').update(body).eq('id',1).select().single())});
}));
router.post('/documents',wrap(async(req,res)=>{
 const body=parse(schema,req.body);allowed(req.user,permissionFor(body.kind));
 if(body.kind.startsWith('OPENING_')&&!can(req.user,'construction.settings'))throw new AppError('Начальные остатки вводит администратор',403);
 if(body.kind.includes('ADVANCE')&&!can(req.user,'construction.settlements')){
  if(body.kind!=='ADVANCE_REPORT')throw new AppError('Денежные операции подтверждает финансовый сотрудник',403);
  const own=checked(await getServiceDB().from('construction_parties').select('user_id').eq('id',body.party_id).single());
  if(own.user_id!==req.user.id)throw new AppError('Можно оформить только свой авансовый отчёт',403);
 }
 const db=getServiceDB();const existing=checked(await db.from('construction_documents').select('*').eq('id',body.id).maybeSingle());
 if(existing){if(existing.created_by!==req.user.id)throw new AppError('Документ недоступен',403);res.json({data:existing});return;}
 if((body.expense_id||body.payment_id)&&!['SETTLEMENT_PAYMENT','ADVANCE_ISSUE','ADVANCE_RETURN','ADVANCE_REIMBURSE'].includes(body.kind))throw new AppError('ПКО/РКО связывается только с денежной операцией',400);
 const data=checked(await db.from('construction_documents').insert({...body,created_by:req.user.id}).select().single());
 res.status(201).json({data});
}));
router.put('/documents/:id',wrap(async(req,res)=>{
 const id=parse(uuid,req.params.id);const body=parse(schema,req.body);
 if(body.id!==id)throw new AppError('Идентификатор документа не совпадает',400);
 const db=getServiceDB();const d=checked(await db.from('construction_documents').select('*').eq('id',id).single());
 allowed(req.user,permissionFor(d.kind));
 if(d.status!=='DRAFT')throw new AppError('Редактируется только черновик',409);
 if(d.created_by!==req.user.id&&!can(req.user,'construction.settings'))throw new AppError('Можно изменить только свой черновик',403);
 if(body.kind!==d.kind)throw new AppError('Тип документа нельзя менять',400);
 if(body.party_id!==d.party_id&&d.kind.includes('ADVANCE')&&!can(req.user,'construction.settlements'))throw new AppError('Подотчётное лицо нельзя менять',403);
 res.json({data:checked(await db.from('construction_documents').update(body).eq('id',id).eq('status','DRAFT').select().single())});
}));
router.post('/documents/:id/price-corrections',wrap(async(req,res)=>{
 allowed(req.user,'construction.settings');
 const id=parse(uuid,req.params.id);
 const body=parse(z.object({id:uuid,expected_version:z.number().int().nonnegative(),reason:z.string().trim().min(3).max(2000),values:z.array(z.number().finite().nonnegative().max(999999999999).refine(n=>Math.abs(n*100-Math.round(n*100))<0.0001,'До двух знаков после запятой')).min(1).max(200)}).strict(),req.body);
 res.json({data:checked(await getServiceDB().rpc('construction_correct_receipt_price',{p_id:body.id,p_receipt:id,p_values:body.values,p_expected:body.expected_version,p_reason:body.reason,p_actor:req.user.id}))});
}));
router.post('/documents/:id/:action',wrap(async(req,res)=>{
 const id=parse(uuid,req.params.id);const db=getServiceDB();
 const d=checked(await db.from('construction_documents').select('*').eq('id',id).single());
 const action=req.params.action;
 if(action==='post'){
  if(d.kind==='ADVANCE_REPORT'){
   const cfg=checked(await db.from('construction_settings').select('approver_user_id').eq('id',1).single());
   if(cfg.approver_user_id!==req.user.id)throw new AppError('Утверждение доступно только назначенному руководителю',403);
  }else allowed(req.user,permissionFor(d.kind));
  res.json({data:checked(await db.rpc('construction_post',{p_id:id,p_actor:req.user.id}))});return;
 }
 if(!['submit','cancel','reject'].includes(action))throw new AppError('Действие не найдено',404);
 if(d.status==='POSTED')throw new AppError('Проведённый документ нельзя изменять',409);
 let status;
 if(action==='reject'){
  const cfg=checked(await db.from('construction_settings').select('approver_user_id').eq('id',1).single());
  if(cfg.approver_user_id!==req.user.id||d.status!=='SUBMITTED')throw new AppError('Нет права отклонить этот отчёт',403);
  status='DRAFT';
 }else{
  allowed(req.user,permissionFor(d.kind));
  if(d.created_by!==req.user.id&&!can(req.user,'construction.settings'))throw new AppError('Можно изменить только свой документ',403);
  if(action==='submit'&&(d.kind!=='ADVANCE_REPORT'||d.status!=='DRAFT'))throw new AppError('На утверждение отправляется черновик авансового отчёта',400);
  status=action==='submit'?'SUBMITTED':'CANCELLED';
 }
 res.json({data:checked(await db.from('construction_documents').update(status==='CANCELLED'?{status,expense_id:null,payment_id:null}:{status}).eq('id',id).eq('status',d.status).select().single())});
}));
export default router;
