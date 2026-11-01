import { recordEvent, safeActivity, presence } from './activity.service.js';
const resources = { reports:'Отчёты', auth:'Авторизация', finance:'Финансы', deals:'Сделки', leads:'Лиды и клиенты', projects:'Объекты ЖК', inventory:'Квартиры и планировки', apartments:'Квартиры', users:'Пользователи', roles:'Права доступа', tasks:'Задачи', construction:'Строительный учёт', costs:'Себестоимость', dictionaries:'Справочники', sms:'SMS', contracts:'Договоры', documents:'Документы', 'document-settings':'Настройки документов', 'discount-schemes':'Скидки', 'sales-plans':'Планы продаж', 'project-media':'Медиа объекта', 'visual-maps':'Генплан', notifications:'Уведомления', automation:'Автоматизация', calls:'Звонки', upload:'Загрузка файлов' };
const safeFields = new Set(['status','amount','amount_minor','currency','cash_desk_id','initial_payment_cash_desk_id','final_price_minor','price_per_m2_minor','down_payment_minor','installment_months','first_payment_date','payment_interval_months','payment_type','payment_date','expense_date','date','category','method','role','permissions','is_active','responsible_user_id','assigned_to','due_date','unit_id','lead_id','deal_id','building_ids','mode','area_m2_x100','sellable_area_m2','is_published','is_cover','sort_order']);
export function describeRequest(req, status, responseId = null) {
 const parts=String(req.originalUrl || '').split('?')[0].split('/').filter(Boolean);const family=parts[1];
 if(!resources[family] || parts[2]==='activity' || family==='auth' && !['login','logout'].includes(parts[2])) return null;
 const login=family==='auth' && parts[2]==='login', logout=family==='auth' && parts[2]==='logout';
 const detailRead=req.method==='GET' && /^\/api\/(?:deals|leads|apartments|projects|tasks|finance\/(?:income|expenses)|inventory\/units)\/\d+\/?$/.test(String(req.originalUrl||'').split('?')[0]);
 const exportRead=req.method==='GET' && /export|download|print/i.test(parts.at(-1) || '');
 if(!login && !logout && !exportRead && !detailRead && !['POST','PUT','PATCH','DELETE'].includes(req.method)) return null;
 const action=login?'LOGIN':logout?'LOGOUT':exportRead?'EXPORT':detailRead?'VIEW':req.method==='DELETE'?'DELETE':req.method==='POST'?'CREATE':'UPDATE';
 const label=login?'Вход в CRM':logout?'Выход из CRM':exportRead?'Выгрузка документа':detailRead?'Открытие карточки':/void|cancel|terminate/.test(parts.at(-1))?'Отмена / аннулирование':req.method==='DELETE'?'Удаление':req.method==='POST'?'Операция / создание':'Изменение';
 const ids=parts.filter(part=>/^\d{1,16}$/.test(part) || /^[0-9a-f-]{36}$/i.test(part));
 return { kind:action, resource:resources[family], entity_id:String(ids.at(-1) || responseId || '').slice(0,80) || null, summary:`${label} · ${resources[family]}`, http_method:req.method, http_status:status, outcome:status<400?'SUCCESS':'FAILED', changed_fields:Object.keys(req.body || {}).filter(key=>safeFields.has(key)) };
}
export function activityMiddleware(req,res,next) {
 let responseId=null, applicationFailure=false; const original=res.json;
 res.json=function(body){applicationFailure=body?.success===false || body?.status==='error' || body?.status==='fail';const data=body?.data;responseId=data?.id || data?.deal?.id || data?.expense?.id || data?.payment?.id || null;return original.call(this,body);};
 res.once('finish',()=>{
  const user=res.locals?.activityUser || req.user;if(!user?.id)return;
  const event=describeRequest(req,res.statusCode,responseId);if(!event)return; if(applicationFailure)event.outcome='FAILED';
  void safeActivity(async()=>{ await recordEvent(user,event);if(event.kind!=='LOGOUT')await presence(user); });
 });next();
}
