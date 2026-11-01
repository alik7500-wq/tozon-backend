import crypto from 'node:crypto';
import { getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { digest, normalizeSettings, prepareRows } from './intake.validation.js';
export const dbCheck = result => { if(result.error) {console.warn('[lead-intake] database failure',{code:result.error.code});throw new AppError('Не удалось выполнить операцию с лидами. Повторите попытку.',503);}return result.data; };
export async function validateSettings(raw) {
 const settings=normalizeSettings(raw), db=getServiceDB();
 if(settings.manager_id){const user=dbCheck(await db.from('users').select('id,is_active,is_sales_rep').eq('id',settings.manager_id).maybeSingle());if(!user?.is_active||!user.is_sales_rep)throw new AppError('Выберите действующего менеджера по продажам',400);}
 if(settings.project_id){const project=dbCheck(await db.from('projects').select('id').eq('id',settings.project_id).maybeSingle());if(!project)throw new AppError('Жилой комплекс не найден',400);}
 return settings;
}
function signature(data, actor, expires){
 if(!process.env.JWT_SECRET)throw new AppError('Подписание импорта не настроено',503);
 return crypto.createHmac('sha256',process.env.JWT_SECRET).update(JSON.stringify({data,actor,expires})).digest('hex');
}
export async function previewImport(body,user) {
 const settings=await validateSettings(body.settings),rows=prepareRows(body.rows);
 const phones=[...new Set(rows.filter(r=>!r.errors.length).map(r=>r.data.phone.slice(1)))];
 const matches=phones.length?dbCheck(await getServiceDB().rpc('crm_intake_matches',{p_phones:phones})):[];
 const results=rows.map(row=>{
  const found=matches.filter(m=>m.phone===row.data.phone?.slice(1)||m.secondary_phone===row.data.phone?.slice(1));
  const active=found.filter(m=>!m.archived);
  const outcome=row.errors.length?'INVALID':row.repeated?'FILE_DUPLICATE':active.length>1?'AMBIGUOUS':active.length===1?'REPEAT':found.length?'ARCHIVED':'CREATED';
  return {...row,outcome,existing_name:active.length===1?active[0].full_name:null};
 });
 const payload={settings,rows:rows.map(r=>r.data)},expires=Date.now()+30*60*1000;
 return {rows:results,payload,expires,token:signature(payload,user.id,expires)};
}
export async function commitImport(body,user) {
 const {payload,expires,token}=body;
 if(!payload||!Number.isSafeInteger(expires)||expires<Date.now()||expires>Date.now()+31*60*1000||!/^\w{64}$/.test(token||''))throw new AppError('Предпросмотр истёк. Проверьте файл заново.',400);
 const expected=signature(payload,user.id,expires);
 if(!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(token)))throw new AppError('Данные изменились: выполните предпросмотр заново',400);
 const settings=await validateSettings(payload.settings),rows=prepareRows(payload.rows),results=[];
 const offset=body.offset ?? 0;
 if(!Number.isInteger(offset)||offset<0||offset>=rows.length)throw new AppError('Некорректная страница импорта',400);
 for(const row of rows.slice(offset,offset+25)){
  if(row.errors.length||row.repeated){results.push({row:row.row,outcome:row.errors.length?'INVALID':'FILE_DUPLICATE',message:row.errors.join('; ')});continue;}
  try{
   const result=dbCheck(await getServiceDB().rpc('crm_intake_lead',{p_scope:'FILE',p_key:digest({settings,row:row.data}),p_lead:row.data,p_settings:settings,p_actor:user.id,p_integration:null}));
   results.push({row:row.row,...result});
  }catch{results.push({row:row.row,outcome:'ERROR',message:'Не сохранено. Повторите импорт: обработанные строки не продублируются.'});}
 }
 return {results,total:rows.length,next_offset:offset+25<rows.length?offset+25:null};
}
