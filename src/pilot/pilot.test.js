import {it,expect,vi} from 'vitest';
import request from 'supertest';
import {pilotConfig,verifyPilotDatabase,TEST_REF,PILOT_ORIGIN} from './config.js';
vi.mock('../modules/auth/auth.router.js',async()=>{const {Router}=await import('express');return {default:Router()};});
vi.mock('../modules/company-projects/company-projects.router.js',async()=>{const {Router}=await import('express');return {default:Router()};});
vi.mock('../modules/company-projects/workspace.router.js',async()=>{const {Router}=await import('express');return {default:Router()};});
vi.mock('../modules/company-projects/workspace.boundary.js',()=>({workspaceBoundary:(req,res,next)=>next()}));
import {createPilotApp} from './app.js';
const key=claims=>'test.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.synthetic';
const config=()=>({NODE_ENV:'production',PROJECT_WORKSPACE_PILOT_CONFIRM:TEST_REF,SUPABASE_URL:`https://${TEST_REF}.supabase.co`,FRONTEND_ORIGIN:PILOT_ORIGIN,JWT_SECRET:'synthetic-pilot-secret',SUPABASE_SERVICE_ROLE_KEY:key({ref:TEST_REF,role:'service_role'})});
it('requires exact isolated database, origin, explicit confirmation and server credentials',()=>{
 expect(pilotConfig(config())).toEqual({origin:PILOT_ORIGIN});
 for(const changes of [{NODE_ENV:'test'},{PROJECT_WORKSPACE_PILOT_CONFIRM:''},{SUPABASE_URL:'https://yeslzrrcwgcqfxhgbrqk.supabase.co'},{SUPABASE_URL:`https://${TEST_REF}.supabase.co/other`},{FRONTEND_ORIGIN:'https://tozon-crm.vercel.app'},{JWT_SECRET:''},{SUPABASE_SERVICE_ROLE_KEY:key({ref:'yeslzrrcwgcqfxhgbrqk',role:'service_role'})},{SUPABASE_SERVICE_ROLE_KEY:key({ref:TEST_REF,role:'anon'})}])expect(()=>pilotConfig({...config(),...changes})).toThrow('ISOLATED_PROJECT_PILOT_CONFIGURATION_REQUIRED');
});
it('exposes only its own health mode and does not mount external sends, hooks or old uploads',async()=>{
 const app=createPilotApp(config());expect((await request(app).get('/api/health')).body).toMatchObject({mode:'isolated-project-pilot',external_sends:false});
 for(const path of ['/api/sms/send','/api/integrations/instagram/webhook','/api/telegram-finance/webhook','/api/internal/project-reminders/run','/api/automation/run-detector','/uploads/file.pdf','/api/finance/payments'])expect((await request(app).post(path).send({})).status).toBe(404);
});
it('rejects untrusted browser origins before routing and returns no-store responses',async()=>{
 const app=createPilotApp(config());expect((await request(app).get('/api/health').set('Origin','https://foreign.example')).status).toBe(403);const r=await request(app).get('/api/health').set('Origin',PILOT_ORIGIN);expect(r.headers['access-control-allow-origin']).toBe(PILOT_ORIGIN);expect(r.headers['cache-control']).toBe('no-store');
});

it('requires a successful database probe before the server starts listening',async()=>{
 const db={from:vi.fn(()=>({select:()=>({limit:async()=>({error:null})})}))};await expect(verifyPilotDatabase(db)).resolves.toBeUndefined();expect(db.from).toHaveBeenCalledWith('company_projects');
 await expect(verifyPilotDatabase({from:()=>({select:()=>({limit:async()=>({error:{message:'invalid key'}})})})})).rejects.toThrow('ISOLATED_PROJECT_PILOT_DATABASE_NOT_READY');
});
