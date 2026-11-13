import {it,expect,vi,beforeEach} from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
const mock=vi.hoisted(()=>({check:vi.fn()}));
vi.mock('./storage.self-test.js',()=>({checkProjectStorage:mock.check}));
vi.mock('../../middleware/auth.middleware.js',()=>({protect:(req,res,next)=>{if(!req.headers['x-role'])return res.sendStatus(401);req.user={id:3,role:req.headers['x-role'],permissions:[]};next();}}));
vi.mock('../../db/connection.js',()=>({getServiceDB:vi.fn()}));
import router from './company-projects.router.js';
const app=express();app.use(cookieParser());app.use(express.json());app.use('/api/company-projects',router);app.use((err,req,res,next)=>res.status(err.statusCode||500).json({message:err.message}));
const url='/api/company-projects/a1d3af61-af16-4e42-9be1-e6dc645929b3/storage-check';
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('COMPANY_PROJECTS_ENABLED','true');vi.stubEnv('PROJECT_WORKSPACE_ENABLED','true');vi.stubEnv('NODE_ENV','test');vi.stubEnv('TEST_SUPABASE_URL','https://yaolkwbnhnacxxjpgiyu.supabase.co');vi.stubEnv('FRONTEND_ORIGIN','https://tozon-crm-commercial-test.onrender.com');mock.check.mockResolvedValue({cleanup:true});});
it('requires administrative login and rejects employees',async()=>{expect((await request(app).post(url).send({})).status).toBe(401);expect((await request(app).post(url).set('x-role','MANAGER').send({})).status).toBe(403);expect(mock.check).not.toHaveBeenCalled();});
it('rejects foreign cookie origin, arbitrary payload and production runtime',async()=>{
 expect((await request(app).post(url).set('x-role','ADMIN').set('Cookie','jwt=test').set('Origin','https://foreign.example').send({})).status).toBe(403);
 expect((await request(app).post(url).set('x-role','ADMIN').send({path:'foreign/object'})).status).toBe(400);
 vi.stubEnv('TEST_SUPABASE_URL','https://production.supabase.co');expect((await request(app).post(url).set('x-role','ADMIN').send({})).status).toBe(503);expect(mock.check).not.toHaveBeenCalled();
});
it('passes only authenticated admin and project ID to the fixed diagnostics',async()=>{const r=await request(app).post(url).set('x-role','ADMIN').set('Cookie','jwt=test').set('Origin','https://tozon-crm-commercial-test.onrender.com').send({});expect(r.status).toBe(200);expect(r.headers['cache-control']).toBe('no-store');expect(mock.check).toHaveBeenCalledWith(3,'a1d3af61-af16-4e42-9be1-e6dc645929b3');});
