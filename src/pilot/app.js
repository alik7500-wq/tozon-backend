import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import authRouter from '../modules/auth/auth.router.js';
import companyRouter from '../modules/company-projects/company-projects.router.js';
import workspaceRouter from '../modules/company-projects/workspace.router.js';
import {workspaceBoundary} from '../modules/company-projects/workspace.boundary.js';
import {pilotConfig} from './config.js';
export function createPilotApp(env=process.env){
 const {origin}=pilotConfig(env);const app=express();app.disable('x-powered-by');
 app.use(helmet({crossOriginResourcePolicy:{policy:'cross-origin'}}));
 app.use((req,res,next)=>{
  res.set('Cache-Control','no-store');
  if(req.headers.origin&&req.headers.origin!==origin)return res.status(403).json({status:'fail',message:'Недопустимый источник запроса'});
  next();
 });
 app.use(cors({origin,credentials:true}));app.use(cookieParser());app.use(express.json({limit:'1mb'}));
 app.get('/api/health',(req,res)=>res.json({status:'success',mode:'isolated-project-pilot',external_sends:false}));
 app.use('/api',workspaceBoundary);
 app.use('/api/auth',rateLimit({windowMs:60000,limit:30,standardHeaders:true,legacyHeaders:false}),authRouter);
 app.use('/api/company-projects',companyRouter);app.use('/api/project-workspace',workspaceRouter);
 // No legacy CRM, public uploads, external webhooks, outbound SMS, bot or cron
 // routes are mounted. The pilot does not import the production server/app.
 app.use((req,res)=>res.status(404).json({status:'fail',message:'Маршрут не входит в тестовое пространство проектов'}));
 app.use((err,req,res,_next)=>res.status(err.statusCode||500).json({status:'error',message:err.statusCode&&err.statusCode<500?err.message:'Ошибка тестового сервиса'}));
 return app;
}
