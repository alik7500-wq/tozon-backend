import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { protect, restrictTo } from '../../middleware/auth.middleware.js';
import { getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { compileTemplate, renderTemplate, sampleTemplate, TYPES, LANGUAGES, FIELDS, MIME } from './template.engine.js';

const text = z.string().max(500).default('');
const company = z.object(Object.fromEntries(['company_name','company_inn','company_address','company_phone','company_bank','company_account','director_name','accountant_name','cashier_name','branch_name'].map(k => [k,text]))).strict();
const pattern = z.string().max(100).refine(s => !s || (/\{id(?:4)?\}/.test(s) && !/[{}]/.test(s.replace(/\{(id|id4|year|project_code|unit|building)\}/g,''))), 'Добавьте {id} или {id4}; используйте только доступные переменные');
export const settingsSchema = z.object({
  company: company.default({}),
  numbering: z.object({ CONTRACT: pattern.default(''), PKO: pattern.default(''), RKO: pattern.default('') }).strict().default({}),
  reservation_days: z.number().int().min(1).max(365).default(3),
  max_discount_percent: z.number().min(0).max(100).default(100),
  builders: z.array(z.object({ name:z.string().min(1).max(200), inn:text, address:text, phone:text }).strict()).max(100).default([]),
  branches: z.array(z.object({ name:z.string().min(1).max(200), address:text, phone:text }).strict()).max(100).default([])
}).strict().refine(data => ![data.numbering.PKO,data.numbering.RKO].some(s=>/\{(project_code|building|unit)\}/.test(s)), 'Для ПКО и РКО доступны только {id}, {id4} и {year}');

const router = Router();
router.use(protect);
const asyncRoute = fn => async (req,res,next) => { try { await fn(req,res); } catch(e) { next(e); } };
const checked = (result) => { if (result.error) {
  if (/STALE_SETTINGS/.test(result.error.message)) throw new AppError('Настройки уже изменены другим пользователем. Обновите страницу.',409);
  if (/TEMPLATE_NOT_FOUND/.test(result.error.message)) throw new AppError('Бланк не найден',404);
  throw result.error;
} return result.data; };
const slot = input => {
  const parsed = z.object({ kind:z.enum(TYPES),language:z.enum(LANGUAGES),scope:z.string().regex(/^(\*|[1-9]\d{0,15})$/).default('*') }).parse(input);
  return parsed;
};
const uuid = z.string().uuid();
const sendDoc = (res,buffer,name) => {
  res.set({ 'Content-Type':MIME,'Content-Disposition':`attachment; filename="${name}.docx"`,'Cache-Control':'no-store' });
  res.send(buffer);
};

router.get('/configuration',asyncRoute(async(req,res) => {
  const row = checked(await getServiceDB().from('crm_document_settings').select('*').eq('id',1).single());
  // Only admins need organisation details and registries. Staff use them in document generation.
  res.json({status:'success',data:{settings:req.user.role==='ADMIN' ? row : {version:row.version,data:{reservation_days:row.data.reservation_days ?? 3,max_discount_percent:row.data.max_discount_percent ?? 100}},fields:FIELDS,types:TYPES,languages:LANGUAGES}});
}));
router.put('/configuration',restrictTo('ADMIN'),asyncRoute(async(req,res) => {
  const data = settingsSchema.parse(req.body.data);
  const version = z.number().int().positive().parse(req.body.version);
  const settings = checked(await getServiceDB().rpc('save_crm_document_settings',{p_actor:req.user.id,p_version:version,p_data:data}));
  res.json({status:'success',data:{settings}});
}));
router.get('/configuration/history',restrictTo('ADMIN'),asyncRoute(async(req,res) => {
  const history = checked(await getServiceDB().from('crm_document_settings_history').select('*').order('created_at',{ascending:false}).limit(30));
  res.json({status:'success',data:{history}});
}));

router.get('/templates',asyncRoute(async(req,res) => {
  let query = getServiceDB().from('crm_document_templates').select('id,kind,language,scope,name,file_size,created_at,created_by,active').order('created_at',{ascending:false});
  if(req.user.role!=='ADMIN') query=query.eq('active',true);
  const templates = checked(await query.limit(500));
  res.json({status:'success',data:{templates}});
}));
router.get('/sample/:kind',restrictTo('ADMIN'),asyncRoute(async(req,res) => {
  const kind=z.enum(TYPES).parse(req.params.kind); sendDoc(res,sampleTemplate(kind),`TOZON-${kind}-sample`);
}));
const upload = multer({storage:multer.memoryStorage(),limits:{fileSize:2*1024*1024,files:1}});
router.post('/templates',restrictTo('ADMIN'),rateLimit({windowMs:60000,max:15,standardHeaders:true,legacyHeaders:false}),upload.single('file'),asyncRoute(async(req,res) => {
  const s=slot(req.body);
  if(!req.file || !/\.docx$/i.test(req.file.originalname)) throw new AppError('Загрузите файл Word .docx',400);
  compileTemplate(req.file.buffer);
  if(s.scope!=='*') {
    const p=checked(await getServiceDB().from('projects').select('id').eq('id',s.scope).maybeSingle());
    if(!p) throw new AppError('ЖК не найден',404);
  }
  const name=z.string().trim().min(1).max(200).parse(req.body.name || req.file.originalname);
  const template=checked(await getServiceDB().from('crm_document_templates').insert({...s,name,file_base64:req.file.buffer.toString('base64'),file_size:req.file.size,created_by:req.user.id}).select('id').single());
  checked(await getServiceDB().rpc('activate_crm_document_template',{p_actor:req.user.id,p_id:template.id}));
  res.status(201).json({status:'success',data:{id:template.id}});
}));
router.post('/templates/:id/activate',restrictTo('ADMIN'),asyncRoute(async(req,res) => {
  checked(await getServiceDB().rpc('activate_crm_document_template',{p_actor:req.user.id,p_id:uuid.parse(req.params.id)}));
  res.json({status:'success'});
}));
router.post('/templates/:id/disable',restrictTo('ADMIN'),asyncRoute(async(req,res) => {
  // Atomic row update; historical version remains available for restoring.
  checked(await getServiceDB().from('crm_document_templates').update({active:false}).eq('id',uuid.parse(req.params.id)));
  res.json({status:'success'});
}));
router.get('/templates/:id/download',restrictTo('ADMIN'),asyncRoute(async(req,res) => {
  const row=checked(await getServiceDB().from('crm_document_templates').select('file_base64').eq('id',uuid.parse(req.params.id)).maybeSingle());
  if(!row) throw new AppError('Бланк не найден',404);
  sendDoc(res,Buffer.from(row.file_base64,'base64'),'TOZON-template');
}));
router.post('/render/:id',rateLimit({windowMs:60000,max:30,standardHeaders:true,legacyHeaders:false}),asyncRoute(async(req,res) => {
  const row=checked(await getServiceDB().from('crm_document_templates').select('*').eq('id',uuid.parse(req.params.id)).maybeSingle());
  if(!row || (!row.active && req.user.role!=='ADMIN')) throw new AppError('Бланк не найден',404);
  const settings=checked(await getServiceDB().from('crm_document_settings').select('data').eq('id',1).single());
  const context={...req.body,...Object.fromEntries(Object.entries(settings.data.company || {}).filter(([,value])=>value !== ''))};
  sendDoc(res,renderTemplate(Buffer.from(row.file_base64,'base64'),context),`TOZON-${row.kind}`);
}));
router.use((err,req,res,next)=>{
  if(err instanceof z.ZodError) return next(new AppError(err.issues.map(i=>i.message).join('; '),400));
  if(err instanceof multer.MulterError) return next(new AppError('Загрузите один файл DOCX размером до 2 МБ',400));
  next(err);
});
export default router;
