import {z} from 'zod';
import bcrypt from 'bcrypt';
import {createHmac} from 'node:crypto';
import {getServiceDB} from '../../db/connection.js';
import {AppError} from '../../shared/errors/errorHandler.js';
const id=z.number().int().positive().max(2147483647),revision=z.number().int().nonnegative();
const sections=z.enum(['inventory.view','leads.view','deals.view','finance.payments','finance.expenses','construction.stock','documents.print']);
const writes=z.enum(['deals.write','contracts.sign','contracts.cancel','contracts.terminate','finance.payments.write','finance.expenses.write','construction.stock.write','documents.manage']);
const base={request_id:z.uuid(),project_revision:z.number().int().positive()};
export const setupSchema=z.discriminatedUnion('kind',[
 z.object({...base,kind:z.literal('CREATE_ACCOUNT'),name:z.string().trim().min(1).max(200),email:z.email().toLowerCase().max(254),password:z.string().min(12).max(72).refine(s=>Buffer.byteLength(s,'utf8')<=72,'Пароль: не более 72 байт'),project_role:z.enum(['PARTNER','DIRECTOR','ACCOUNTANT','MANAGER','CASHIER','WAREHOUSE'])}).strict(),
 z.object({...base,kind:z.literal('SET_ACCESS'),user_id:id,revision,enabled:z.boolean(),sections:z.array(sections).max(7),write_sections:z.array(writes).max(8)}).strict(),
 z.object({...base,kind:z.literal('RESOURCE'),resource:z.enum(['cash_desks','warehouses']),id:z.uuid().nullable(),name:z.string().trim().max(200)}).strict(),
 z.object({...base,kind:z.literal('BIND_DEMO_DEAL'),deal_id:id,expected_updated_at:z.string().max(100).nullable(),confirmed:z.literal(true)}).strict(),
]);
export async function setupRpc(name,args){
 const {data,error}=await getServiceDB().rpc(name,args);
 if(!error)return data;
 const message=String(error.message||'');
 if(message.includes('DEDICATED_PROJECT_ACCOUNT_REQUIRED'))throw new AppError('Нужна отдельная проектная учётная запись. Общего администратора ограничивать нельзя.',403);
 if(message.includes('GLOBAL_PROFILE_REVIEW_REQUIRED'))throw new AppError('У профиля есть отключение и назначения в других проектах. Нужна отдельная проверка перед восстановлением.',409);
 if(message.includes('ACCESS_DEPENDENCIES_REQUIRED'))throw new AppError('Отметьте необходимые права чтения для выбранных операций.',400);
 if(error.code==='42501')throw new AppError('Нет права на эту настройку или запись принадлежит другому проекту.',403);
 if(error.code==='40001')throw new AppError('Настройки изменились. Обновите блок перед сохранением.',409);
 if(error.code==='23505')throw new AppError('Email или ключ операции уже используется. Проверьте данные.',409);
 if(error.code==='P0002')throw new AppError('Запись не найдена в выбранном проекте.',404);
 if(error.code==='23514')throw new AppError('Есть история или спорные связи: требуется отдельная проверка. Автоматический перенос запрещён.',409);
 if(['22023','22P02','23503','23502'].includes(error.code))throw new AppError('Проверьте параметры настройки проекта.',400);
 throw new AppError('Настройка не подтверждена. Повторите ту же операцию с тем же ключом.',503);
}
export async function executeSetup(actor,project,body){
 const parsed=setupSchema.safeParse(body);if(!parsed.success)throw new AppError(parsed.error.issues.map(i=>i.message).join('; '),400);
 const {request_id,kind,...payload}=parsed.data;
 if(kind==='CREATE_ACCOUNT'){
  if(!process.env.JWT_SECRET)throw new AppError('Авторизация сервиса не настроена',503);
  payload.password_fingerprint=createHmac('sha256',process.env.JWT_SECRET).update(JSON.stringify([project,payload.name,payload.email,payload.project_role,payload.password])).digest('hex');
  payload.password_hash=await bcrypt.hash(payload.password,12);delete payload.password;
 }
 return setupRpc('execute_company_project_admin',{p_actor:actor,p_project:project,p_request:request_id,p_kind:kind,p_payload:payload});
}
