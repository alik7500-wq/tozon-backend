import express from 'express';
import {pathToFileURL} from 'node:url';
import {commercialRuntimeConfig} from './runtime-config.js';

export async function buildCommercialServer(env=process.env) {
 const config=commercialRuntimeConfig(env);
 const root=express();
 root.disable('x-powered-by');
 root.use((req,res,next)=>{
  res.set('Cache-Control','no-store');
  const origin=req.get('origin');
  if(origin && origin!==config.origin)return res.status(403).json({status:'error',message:'ORIGIN_NOT_ALLOWED'});
  if(origin){res.set('Access-Control-Allow-Origin',origin);res.set('Access-Control-Allow-Credentials','true');res.vary('Origin');}
  if(req.method==='OPTIONS'){res.set('Access-Control-Allow-Headers','Content-Type, Authorization');res.set('Access-Control-Allow-Methods','GET, POST, PUT, PATCH, DELETE, OPTIONS');return res.sendStatus(204);}
  next();
 });
 const state={status:config.ready?'starting':'setup_required',projectRef:config.projectRef,crmReady:false,missing:config.missing};
 root.get('/api/health',(req,res)=>res.json(state));
 root.get('/',(req,res)=>res.type('text/plain').send(state.crmReady?'TOZON CRM isolated test API':'TOZON CRM test environment: configuration required.'));
 if(config.ready) {
  // Prevent the legacy connection module from loading any developer/production .env.
  process.env.DOTENV_CONFIG_PATH='/dev/null';
  process.env.NODE_ENV='production';
  process.env.SUPABASE_URL=env.SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY=config.serviceKey;
  process.env.SUPABASE_KEY=config.serviceKey;
  process.env.JWT_SECRET=env.JWT_SECRET;
  process.env.PAYOM_MOCK_MODE='true';
  process.env.SALES_AUTOMATION_ENABLED='false';
  process.env.SMS_PAYMENT_REMINDER_AUTO_ENABLED='false';
  process.env.SMS_PAYMENT_REMINDER_DETECTOR_ENABLED='false';
  process.env.SMS_OUTBOX_CONFIRM_ENABLED='false';
  const {connectDB,getServiceDB}=await import('../db/connection.js');
  connectDB();
  const {error}=await getServiceDB().from('users').select('id',{head:true,count:'exact'});
  if(error){state.status='database_connection_failed';state.missing=[];}
  else {
   // No Telegram startup, cron workers or one-time production tasks are imported.
   root.use(['/api/sms','/api/telegram-finance','/api/calls','/api/automation','/api/leads/webhook'],(req,res)=>res.status(503).json({status:'error',message:'Интеграции в тестовой среде отключены'}));
   const {app}=await import('../app.js');
   root.use(app);
   state.status='ready';state.crmReady=true;
  }
 }
 root.use((req,res)=>res.status(503).json({status:'setup_required',message:'Тестовая CRM ещё настраивается. Серверный ключ необходимо добавить в Render.'}));
 return root;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 buildCommercialServer().then(app=>{
  const server=app.listen(Number(process.env.PORT)||10000,'0.0.0.0',()=>console.log('COMMERCIAL_TEST_SERVER_LISTENING'));
  process.once('SIGTERM',()=>server.close(()=>process.exit(0)));
 }).catch(()=>{console.error('COMMERCIAL_TEST_STARTUP_FAILED');process.exitCode=1;});
}
