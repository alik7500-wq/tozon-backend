import { Router } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { protect } from '../../middleware/auth.middleware.js';
import { getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { normalizeRow, digest } from './intake.validation.js';
import { validateSettings, previewImport, commitImport, dbCheck } from './intake.service.js';
import { readIntakeFile } from './intake.files.js';
const router=Router();
const wrap=fn=>async(req,res,next)=>{try{await fn(req,res)}catch(error){next(error)}};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safeColumns='id,name,source,campaign,project_id,manager_id,is_active,created_at,last_received_at';
const limitWebhook=rateLimit({windowMs:60000,limit:120,keyGenerator:req=>String(req.params.id).slice(0,40),standardHeaders:'draft-7',legacyHeaders:false,message:{message:'Слишком много заявок. Повторите через минуту.'}});
router.post('/google/:id',limitWebhook,wrap(async(req,res)=>{
 if(!uuid.test(req.params.id))throw new AppError('Подключение не найдено',404);
 const token=req.headers['x-lead-intake-key'];
 if(typeof token!=='string'||token.length>200)throw new AppError('Неверный ключ подключения',401);
 const config=dbCheck(await getServiceDB().from('crm_lead_integrations').select('*').eq('id',req.params.id).maybeSingle());
 const actual=digest(token), expected=config?.token_hash;
 if(!config?.is_active||!expected||expected.length!==actual.length||!crypto.timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))throw new AppError('Подключение отключено или ключ неверен',401);
 const {data,errors}=normalizeRow(req.body);
 if(errors.length)throw new AppError(errors.join('; '),422);
 const key=req.body.external_key;
 if(typeof key!=='string'||!key.trim()||key.length>128)throw new AppError('Отсутствует уникальный идентификатор ответа формы',422);
 const result=dbCheck(await getServiceDB().rpc('crm_intake_lead',{p_scope:`GOOGLE:${config.id}`,p_key:key,p_lead:data,p_settings:{},p_actor:null,p_integration:config.id}));
 // No customer details or CRM credentials are returned to the external caller.
 res.json({data:result});
}));
router.use(protect);
router.use((req,res,next)=>['ADMIN','DIRECTOR'].includes(req.user?.role)?next():next(new AppError('Импорт и подключение источников доступны руководителю и администратору',403)));
router.get('/options',wrap(async(req,res)=>{
 const db=getServiceDB();const [users,projects]=await Promise.all([db.from('users').select('id,name').eq('is_active',1).eq('is_sales_rep',true).order('name'),db.from('projects').select('id,name').order('name')]);
 res.json({data:{managers:dbCheck(users),projects:dbCheck(projects)}});
}));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:2*1024*1024,files:1,fields:0}});
router.post('/file', (req,res,next)=>upload.single('file')(req,res,error=>error?next(new AppError('Файл слишком большой или повреждён. Максимум 2 МБ.',400)):next()),wrap(async(req,res)=>{
 let sheets;try{sheets=await readIntakeFile(req.file)}catch(e){if(e instanceof AppError)throw e;throw new AppError('Не удалось прочитать файл. Используйте Excel .xlsx или CSV UTF-8.',400)}
 if(!sheets.length)throw new AppError('В файле нет строк с лидами после заголовков',400);
 res.json({data:{sheets}});
}));
router.post('/preview',wrap(async(req,res)=>res.json({data:await previewImport(req.body,req.user)})));
router.post('/commit',wrap(async(req,res)=>res.json({data:await commitImport(req.body,req.user)})));
router.get('/integrations',wrap(async(req,res)=>{
 const db=getServiceDB();const configs=dbCheck(await db.from('crm_lead_integrations').select(safeColumns).order('created_at',{ascending:false}));
 const recent=dbCheck(await db.from('crm_lead_inquiries').select('id,integration_id,lead_id,outcome,campaign,created_at').not('integration_id','is',null).order('id',{ascending:false}).limit(50));
 res.json({data:{integrations:configs,recent}});
}));
router.post('/integrations',wrap(async(req,res)=>{
 const settings=await validateSettings(req.body);
 // This screen prepares Google Forms only; other platforms require their own adapters.
 if(!['WEBINAR','GOOGLE_FORM'].includes(settings.source))throw new AppError('Для Google Формы выберите Вебинар или Google Форма',400);
 const name=String(req.body.name||settings.campaign).trim().slice(0,160);
 const token=crypto.randomBytes(32).toString('hex');
 const integration=dbCheck(await getServiceDB().from('crm_lead_integrations').insert({...settings,name,token_hash:digest(token),created_by:req.user.id}).select(safeColumns).single());
 res.status(201).json({data:{integration,token}});
}));
router.patch('/integrations/:id',wrap(async(req,res)=>{
 if(!uuid.test(req.params.id))throw new AppError('Некорректное подключение',400);
 let patch={};
 if(req.body.rotate===true){const token=crypto.randomBytes(32).toString('hex');patch={token_hash:digest(token)};const integration=dbCheck(await getServiceDB().from('crm_lead_integrations').update(patch).eq('id',req.params.id).select(safeColumns).maybeSingle());if(!integration)throw new AppError('Подключение не найдено',404);return res.json({data:{integration,token}});}
 if(typeof req.body.is_active!=='boolean')throw new AppError('Укажите состояние подключения',400);
 patch.is_active=req.body.is_active;
 const integration=dbCheck(await getServiceDB().from('crm_lead_integrations').update(patch).eq('id',req.params.id).select(safeColumns).maybeSingle());
 if(!integration)throw new AppError('Подключение не найдено',404);
 res.json({data:{integration}});
}));
export default router;
