import {assertInternalReminders,reminderRpc} from './workspace.reminders.js';
import express from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import {documentDetails,downloadTemplate,downloadFile,uploadFile,readFiles,readDocument,printableCard,authorizeDocument,FILE_LIMIT} from './workspace.documents.js';
import { z } from 'zod';
import { protect } from '../../middleware/auth.middleware.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { assertWorkspacePilotRuntime, isProjectOnlyUser } from './workspace.boundary.js';
import { readWorkspace, readWorkspaceOptions, readWorkspaceOverview, readWorkspaceInventory } from './workspace.repository.js';
import { parseWorkspaceCommand, executeWorkspaceCommand } from './workspace.commands.js';
import {offerSchema,prepareOffer} from './workspace.offer.js';

const router = express.Router();
const resource = z.enum(['complexes', 'units', 'leads', 'deals', 'payments', 'schedules', 'expenses', 'warehouses']);
const pageSchema = z.object({ after: z.string().max(40).regex(/^(?:[0-9]{1,18}|[0-9a-f-]{36})?$/).optional(), limit: z.string().regex(/^\d{1,3}$/).transform(Number).refine(n => n >= 1 && n <= 100).optional() }).strict();
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('Некорректные параметры рабочего пространства', 400);
  return result.data;
}
router.use(protect);
router.use((req, res, next) => {
  try {
    if (!isProjectOnlyUser(req.user)) throw new AppError('Этот раздел предназначен для проектной учётной записи', 403);
    assertWorkspacePilotRuntime();
    // The legacy app has permissive CORS. Cookie-based cross-origin reads of
    // scoped data must also be limited to the configured frontend.
    if (req.cookies?.jwt && req.headers.origin) trustedWriteOrigin(req);
    res.set('Cache-Control', 'no-store'); next();
  } catch (e) { next(e); }
});
function trustedWriteOrigin(req) {
  if (!req.cookies?.jwt) return;
  let allowed;try { allowed = new URL(process.env.FRONTEND_ORIGIN).origin; } catch { /* deny */ }
  if (!allowed || req.headers.origin !== allowed) throw new AppError('Недопустимый источник запроса',403);
}
function documentParams(req) {
  if (process.env.PROJECT_WORKSPACE_DOCUMENTS_ENABLED !== 'true') throw new AppError('Документы пилота ещё не включены',403);
  return [parse(z.uuid(),req.params.project),parse(z.string().regex(/^[1-9]\d{0,9}$/).transform(Number).refine(n=>n<=2147483647),req.params.deal)];
}
const sendBinary=(res,result)=>{
  res.set({'Content-Type':result.type,'Content-Disposition':`attachment; filename="TOZON-document"; filename*=UTF-8''${encodeURIComponent(result.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())}`,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",'Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache'});
  res.send(result.buffer);
};
const documentLimiter=rateLimit({windowMs:60000,max:30,standardHeaders:true,legacyHeaders:false});
router.post('/:project/offers/preview',documentLimiter,async(req,res,next)=>{
 try{
  if(process.env.PROJECT_WORKSPACE_DOCUMENTS_ENABLED!=='true')throw new AppError('Печать предложений ещё не включена',403);
  trustedWriteOrigin(req);parse(z.object({}).strict(),req.query);
  const project=parse(z.uuid(),req.params.project),input=parse(offerSchema,req.body);
  res.json({status:'success',data:await prepareOffer(req.user.id,project,input,req.user.name)});
 }catch(e){next(e);}
});
const fileUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:FILE_LIMIT,files:1,fields:0}}).single('file');
router.get('/:project/documents/:deal',documentLimiter,async(req,res,next)=>{
 try {const [project,deal]=documentParams(req);parse(z.object({}).strict(),req.query);res.json({status:'success',data:await documentDetails(req.user.id,project,deal)});}catch(e){next(e);}
});
router.get('/:project/documents/:deal/preview',documentLimiter,async(req,res,next)=>{
 try {const [project,deal]=documentParams(req);parse(z.object({}).strict(),req.query);const data=await readDocument(req.user.id,project,deal);res.set({'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",'Cache-Control':'private, no-store'});res.send(printableCard(data));}catch(e){next(e);}
});
router.get('/:project/documents/:deal/word/:kind/:language',documentLimiter,async(req,res,next)=>{
 try {const [project,deal]=documentParams(req);parse(z.object({}).strict(),req.query);const kind=parse(z.enum(['CONTRACT','SCHEDULE']),req.params.kind),lang=parse(z.enum(['RU','TJ','UZ','EN']),req.params.language);sendBinary(res,await downloadTemplate(req.user.id,project,deal,kind,lang));}catch(e){next(e);}
});
router.get('/:project/documents/:deal/files',documentLimiter,async(req,res,next)=>{
 try {const [project,deal]=documentParams(req),page=parse(pageSchema,req.query);res.json({status:'success',data:await readFiles(req.user.id,project,deal,null,page.after||'',page.limit||100)});}catch(e){next(e);}
});
router.get('/:project/documents/:deal/files/:file',documentLimiter,async(req,res,next)=>{
 try {const [project,deal]=documentParams(req);parse(z.object({}).strict(),req.query);sendBinary(res,await downloadFile(req.user.id,project,deal,parse(z.uuid(),req.params.file)));}catch(e){next(e);}
});
router.post('/:project/documents/:deal/files',documentLimiter,async(req,res,next)=>{
 try {
  const [project,deal]=documentParams(req);parse(z.object({}).strict(),req.query);
  if(process.env.PROJECT_WORKSPACE_WRITES_ENABLED!=='true'||process.env.PROJECT_WORKSPACE_FILES_ENABLED!=='true')throw new AppError('Загрузка вложений пилота ещё не включена',403);
  trustedWriteOrigin(req);const id=parse(z.uuid(),req.get('X-Request-ID'));
  await authorizeDocument(req.user.id,project,deal,true); // Authorize before buffering a multipart body.
  fileUpload(req,res,async error=>{
   if(error)return next(new AppError('Загрузите один файл PDF/JPEG/PNG до 10 МБ',400));
   try {res.status(201).json({status:'success',data:await uploadFile(req.user.id,project,deal,id,req.file)});}catch(e){next(e);}
  });
 }catch(e){next(e);}
});
router.get('/projects', async (req, res, next) => {
  try { parse(z.object({}).strict(), req.query); res.json({ status: 'success', data: await readWorkspace(req.user.id, null, 'projects') }); } catch (e) { next(e); }
});
router.get('/:project/overview',async(req,res,next)=>{
 try{const project=parse(z.uuid(),req.params.project);parse(z.object({}).strict(),req.query);res.json({status:'success',data:await readWorkspaceOverview(req.user.id,project)});}catch(e){next(e);}
});
router.get('/:project/inventory',async(req,res,next)=>{
 try{
  const project=parse(z.uuid(),req.params.project);
  const query=parse(z.object({complex_id:z.string().regex(/^[1-9]\d{0,9}$/).transform(Number).refine(n=>n<=2147483647).optional()}).strict(),req.query);
  res.json({status:'success',data:await readWorkspaceInventory(req.user.id,project,query.complex_id??null)});
 }catch(e){next(e);}
});
router.post('/:project/commands', async (req, res, next) => {
  try {
    if (process.env.PROJECT_WORKSPACE_WRITES_ENABLED !== 'true') throw new AppError('Операции записи пилота ещё не включены', 403);
    // Cookie authentication requires an exact trusted browser origin. Bearer-only
    // callers must already hold the verified CRM token; a forged header cannot
    // bypass this check when a cookie is present.
    trustedWriteOrigin(req);
    const project = parse(z.uuid(), req.params.project);
    const result = await executeWorkspaceCommand(req.user.id, project, parseWorkspaceCommand(req.body));
    res.status(result.idempotent ? 200 : 201).json({ status: 'success', data: result });
  } catch (e) { next(e); }
});
router.get('/:project/options{/:kind}', async (req, res, next) => {
  try {
    const project = parse(z.uuid(), req.params.project);
    const kind = parse(z.enum(['context','units','leads','deals','cash_desks','warehouses','parties','materials','complexes','schemes','cancel_drafts','terminate_deals']), req.params.kind || 'context');
    const page = parse(pageSchema, req.query);
    if (kind === 'context' && Object.keys(page).length) throw new AppError('Параметры страницы не требуются', 400);
    const data = await readWorkspaceOptions(req.user.id, project, kind, page);
    if (kind === 'context' && process.env.PROJECT_WORKSPACE_WRITES_ENABLED !== 'true') data.commands = [];
    res.json({ status: 'success', data });
  } catch (e) { next(e); }
});
router.get('/:project/reminders',async(req,res,next)=>{
 try{assertInternalReminders();const project=parse(z.uuid(),req.params.project),page=parse(pageSchema,req.query);res.json({status:'success',data:await reminderRpc('read_company_project_reminders',{p_actor:req.user.id,p_project:project,p_after:page.after||'',p_limit:page.limit||50})});}catch(e){next(e);}
});
router.post('/:project/reminders/:id/read',async(req,res,next)=>{
 try{assertInternalReminders();trustedWriteOrigin(req);parse(z.object({}).strict(),req.query);parse(z.object({}).strict(),req.body||{});const project=parse(z.uuid(),req.params.project),id=parse(z.uuid(),req.params.id);res.json({status:'success',data:await reminderRpc('ack_company_project_reminder',{p_actor:req.user.id,p_project:project,p_record:id})});}catch(e){next(e);}
});
router.get('/:project/:resource{/:record}', async (req, res, next) => {
  try {
    const project = parse(z.uuid(), req.params.project);
    const kind = parse(resource, req.params.resource);
    const page = parse(pageSchema, req.query);
    const record = req.params.record ? parse(kind === 'warehouses' ? z.uuid() : z.string().regex(/^[1-9]\d{0,17}$/), req.params.record) : null;
    if (record && Object.keys(page).length) throw new AppError('Параметры страницы недопустимы для отдельной записи', 400);
    res.json({ status: 'success', data: await readWorkspace(req.user.id, project, kind, { ...page, record }) });
  } catch (e) { next(e); }
});
router.use((req, res, next) => next(new AppError('Операция рабочего пространства не разрешена', 403)));
export default router;
