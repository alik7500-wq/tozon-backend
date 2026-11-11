import {setupRpc,executeSetup} from './company-projects.setup.js';
import rateLimit from 'express-rate-limit';
import {projectReadiness} from './company-projects.readiness.js';
import {assertWorkspacePilotRuntime} from './workspace.boundary.js';
import {assertInternalReminders,reminderRpc} from './workspace.reminders.js';
import express from 'express';
import { z } from 'zod';
import { protect } from '../../middleware/auth.middleware.js';
import { hasSection } from '../../middleware/sectionAccess.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { projectRegistry, saveCompanyProject } from './company-projects.repository.js';
import { parseCompanyProject } from './company-projects.validation.js';

const router = express.Router();
// Preparation registry only. This flag never enables access to business records.
router.use((req, res, next) => process.env.COMPANY_PROJECTS_ENABLED === 'true' ? next() : next(new AppError('Раздел проектов компании ещё не включён', 404)));
router.use(protect);
router.use((req, res, next) => {
  if (req.user.role !== 'ADMIN' || !hasSection(req.user, 'settings.view', true) || !hasSection(req.user, 'users.view', true))
    return next(new AppError('Реестр проектов доступен администратору компании с правом настройки и управления персоналом', 403));
  res.set('Cache-Control', 'no-store');
  next();
});
function reminderOrigin(req){
 if(!req.cookies?.jwt)return;
 let origin;try{origin=new URL(process.env.FRONTEND_ORIGIN).origin;}catch{/* deny */}
 if((req.method!=='GET'||req.headers.origin)&&(!origin||req.headers.origin!==origin))throw new AppError('Недопустимый источник запроса',403);
}
const setupLimit=rateLimit({windowMs:60000,limit:20,standardHeaders:true,legacyHeaders:false});
router.get('/:id/setup',async(req,res,next)=>{
 try{assertWorkspacePilotRuntime();reminderOrigin(req);const id=z.uuid().parse(req.params.id);z.object({}).strict().parse(req.query);res.json({status:'success',data:await setupRpc('read_company_project_setup',{p_actor:req.user.id,p_project:id})});}catch(e){next(e instanceof z.ZodError?new AppError('Некорректный проект',400):e);}
});
router.get('/:id/unbound-deals',async(req,res,next)=>{
 try{assertWorkspacePilotRuntime();reminderOrigin(req);const id=z.uuid().parse(req.params.id),page=z.object({after:z.coerce.number().int().nonnegative().default(0)}).strict().parse(req.query);res.json({status:'success',data:await setupRpc('read_company_project_unbound_deals',{p_actor:req.user.id,p_project:id,p_after:page.after})});}catch(e){next(e instanceof z.ZodError?new AppError('Некорректная страница',400):e);}
});
router.post('/:id/setup',setupLimit,async(req,res,next)=>{
 try{assertWorkspacePilotRuntime();reminderOrigin(req);const id=z.uuid().parse(req.params.id);z.object({}).strict().parse(req.query);res.json({status:'success',data:await executeSetup(req.user.id,id,req.body)});}catch(e){next(e instanceof z.ZodError?new AppError('Некорректный проект',400):e);}
});
router.get('/:id/readiness',async(req,res,next)=>{
 try{assertWorkspacePilotRuntime();reminderOrigin(req);const id=z.uuid().parse(req.params.id);z.object({}).strict().parse(req.query);const snapshot=await reminderRpc('read_company_project_readiness',{p_actor:req.user.id,p_project:id});res.json({status:'success',data:projectReadiness(snapshot)});}catch(e){next(e instanceof z.ZodError?new AppError('Некорректный запрос проверки проекта',400):e);}
});
router.get('/:id/reminders',async(req,res,next)=>{
 try{assertInternalReminders();reminderOrigin(req);const id=z.uuid().parse(req.params.id);res.json({status:'success',data:{settings:await reminderRpc('company_project_reminder_configuration',{p_actor:req.user.id,p_project:id})}});}catch(e){next(e instanceof z.ZodError?new AppError('Некорректный проект',400):e);}
});
router.put('/:id/reminders',async(req,res,next)=>{
 try{assertInternalReminders();reminderOrigin(req);const id=z.uuid().parse(req.params.id),body=z.object({revision:z.number().int().nonnegative(),enabled:z.boolean(),lead_days:z.number().int().min(0).max(30),backlog_from:z.iso.date().nullable()}).strict().parse(req.body);res.json({status:'success',data:{settings:await reminderRpc('save_company_project_reminders',{p_actor:req.user.id,p_project:id,p_revision:body.revision,p_enabled:body.enabled,p_lead_days:body.lead_days,p_backlog_from:body.backlog_from})}});}catch(e){next(e instanceof z.ZodError?new AppError('Проверьте настройки напоминаний',400):e);}
});
router.get('/', async (req, res, next) => {
  try { res.json({ status: 'success', data: await projectRegistry() }); } catch (e) { next(e); }
});
router.post('/', async (req, res, next) => {
  try { res.status(201).json({ status: 'success', data: { project: await saveCompanyProject(null, parseCompanyProject(req.body), req.user.id) } }); } catch (e) { next(e); }
});
router.put('/:id', async (req, res, next) => {
  try {
    if (!z.uuid().safeParse(req.params.id).success) throw new AppError('Некорректный проект', 400);
    res.json({ status: 'success', data: { project: await saveCompanyProject(req.params.id, parseCompanyProject(req.body, true), req.user.id) } });
  } catch (e) { next(e); }
});
export default router;
