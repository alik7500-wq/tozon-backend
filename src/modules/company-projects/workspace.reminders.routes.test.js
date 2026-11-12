import {beforeEach,it,expect,vi} from 'vitest';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
const m=vi.hoisted(()=>({rpc:vi.fn(),user:vi.fn(),from:vi.fn()}));
vi.mock('../../db/connection.js',()=>({getServiceDB:()=>({rpc:m.rpc,from:m.from})}));
vi.mock('../users/users.repository.js',()=>({UsersRepository:{findById:m.user}}));
vi.mock('./company-projects.repository.js',()=>({projectRegistry:vi.fn(),saveCompanyProject:vi.fn()}));
vi.mock('./workspace.repository.js',()=>({readWorkspace:vi.fn(),readWorkspaceOptions:vi.fn(),readWorkspaceOverview:vi.fn()}));
import admin from './company-projects.router.js';
import workspace from './workspace.router.js';
import scheduler from './workspace.reminders.router.js';
import {workspaceBoundary} from './workspace.boundary.js';
const app=express();app.use(express.json());app.use(cookieParser());app.use('/api',workspaceBoundary);app.use('/api/company-projects',admin);app.use('/api/project-workspace',workspace);app.use('/api/internal/project-reminders',scheduler);app.use((e,req,res,next)=>res.status(e.statusCode||500).json({message:e.message}));
const project='00000000-0000-4000-8000-000000000001',id='00000000-0000-4000-8000-000000000002';
const token=()=>jwt.sign({id:10},'reminder-test-secret'),auth=r=>r.set('Authorization','Bearer '+token());
beforeEach(()=>{vi.clearAllMocks();for(const key of ['PROJECT_INTERNAL_REMINDERS_ENABLED','PROJECT_WORKSPACE_ENABLED','COMPANY_PROJECTS_ENABLED'])vi.stubEnv(key,'true');vi.stubEnv('PROJECT_WORKSPACE_WRITES_ENABLED','false');vi.stubEnv('TEST_SUPABASE_URL','https://yaolkwbnhnacxxjpgiyu.supabase.co');vi.stubEnv('JWT_SECRET','reminder-test-secret');vi.stubEnv('FRONTEND_ORIGIN','https://trusted.example');m.user.mockResolvedValue({id:10,is_active:1,role:'ADMIN',permissions:['company.project-only']});m.rpc.mockResolvedValue({data:{records:[],has_more:false}});});
it('reads only for the verified actor and rejects actor overrides',async()=>{
 expect((await auth(request(app).get(`/api/project-workspace/${project}/reminders`))).status).toBe(200);expect(m.rpc).toHaveBeenCalledWith('read_company_project_reminders',expect.objectContaining({p_actor:10,p_project:project}));expect((await auth(request(app).get(`/api/project-workspace/${project}/reminders?actor=20`))).status).toBe(400);
});
it('allows personal read acknowledgement without giving financial mutation rights and protects cookie origin',async()=>{
 expect((await auth(request(app).post(`/api/project-workspace/${project}/reminders/${id}/read`).send({}))).status).toBe(200);expect(m.rpc).toHaveBeenCalledWith('ack_company_project_reminder',{p_actor:10,p_project:project,p_record:id});
 expect((await request(app).post(`/api/project-workspace/${project}/reminders/${id}/read`).set('Cookie','jwt='+token()).set('Origin','https://foreign.example').send({})).status).toBe(403);
});
it('keeps settings company-admin-only with strict bodies, correct origin and feature gating',async()=>{
 const path=`/api/company-projects/${project}/reminders`;
 expect((await auth(request(app).get(path))).status).toBe(403);
 m.user.mockResolvedValue({id:10,is_active:1,role:'ADMIN',permissions:[]});expect((await auth(request(app).get(path))).status).toBe(200);
 expect((await auth(request(app).put(path).send({enabled:true,revision:0,lead_days:3,backlog_from:null,actor:20}))).status).toBe(400);
 expect((await request(app).put(path).set('Cookie','jwt='+token()).set('Origin','https://foreign.example').send({enabled:false,revision:0,lead_days:3,backlog_from:null})).status).toBe(403);
 m.user.mockResolvedValue({id:10,is_active:1,role:'ADMIN',permissions:['company.project-only']});vi.stubEnv('PROJECT_INTERNAL_REMINDERS_ENABLED','false');expect((await auth(request(app).get(`/api/project-workspace/${project}/reminders`))).status).toBe(404);
});
it('runs the internal reminder scheduler under the dedicated token while SMS is disabled',async()=>{
 vi.stubEnv('SMS_SCHEDULER_INTERNAL_TOKEN','reminder-internal-synthetic-token');vi.stubEnv('SMS_PAYMENT_REMINDER_DETECTOR_ENABLED','false');m.from.mockReturnValue({select:()=>({eq:async()=>({data:[]})})});
 const r=await request(app).post('/api/internal/project-reminders/run').set('Authorization','Bearer reminder-internal-synthetic-token');expect(r.status).toBe(200);expect(r.body.data).toMatchObject({enabled:true,added:0});
 expect((await auth(request(app).post('/api/internal/project-reminders/run'))).status).toBe(401);
 expect((await request(app).post('/api/internal/project-reminders/run').set('Cookie','jwt='+token()).set('Authorization','Bearer reminder-internal-synthetic-token')).status).toBe(403);
});

it('protects the read-only readiness audit from scoped actors, actor overrides and wrong cookie origin',async()=>{
 const path=`/api/company-projects/${project}/readiness`;expect((await auth(request(app).get(path))).status).toBe(403);
 m.user.mockResolvedValue({id:10,is_active:1,role:'ADMIN',permissions:[]});m.rpc.mockResolvedValue({data:{members:[]}});
 expect((await auth(request(app).get(path))).status).toBe(200);expect(m.rpc).toHaveBeenCalledWith('read_company_project_readiness',{p_actor:10,p_project:project});
 expect((await auth(request(app).get(path+'?actor=20'))).status).toBe(400);
 expect((await request(app).get(path).set('Cookie','jwt='+token()).set('Origin','https://foreign.example')).status).toBe(403);
 vi.stubEnv('TEST_SUPABASE_URL','https://yeslzrrcwgcqfxhgbrqk.supabase.co');expect((await auth(request(app).get(path))).status).toBe(503);
});

it('keeps setup admin-only, uses the verified actor and protects writes from foreign Origin',async()=>{
 const path=`/api/company-projects/${project}/setup`;expect((await auth(request(app).get(path))).status).toBe(403);m.user.mockResolvedValue({id:10,is_active:1,role:'ADMIN',permissions:[]});m.rpc.mockResolvedValue({data:{revision:2,members:[]}});
 expect((await auth(request(app).get(path))).status).toBe(200);expect(m.rpc).toHaveBeenCalledWith('read_company_project_setup',{p_actor:10,p_project:project});
 const body={request_id:id,kind:'RESOURCE',project_revision:2,resource:'cash_desks',id:null,name:'Test desk'};
 expect((await auth(request(app).post(path).send(body))).status).toBe(200);expect(m.rpc).toHaveBeenCalledWith('execute_company_project_admin',expect.objectContaining({p_actor:10,p_project:project,p_payload:expect.objectContaining({name:'Test desk'})}));
 expect((await auth(request(app).post(path).send({...body,actor:30}))).status).toBe(400);expect((await request(app).post(path).set('Cookie','jwt='+token()).set('Origin','https://foreign.example').send(body)).status).toBe(403);
});
