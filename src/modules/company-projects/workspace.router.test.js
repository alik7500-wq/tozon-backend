import { beforeEach,describe,it,expect,vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';
const mocks=vi.hoisted(()=>({findUser:vi.fn(),read:vi.fn()}));
vi.mock('../users/users.repository.js',()=>({UsersRepository:{findById:mocks.findUser}}));
vi.mock('./workspace.repository.js',()=>({readWorkspace:mocks.read}));
vi.mock('../../db/connection.js',()=>({getServiceDB:vi.fn()}));
import router from './workspace.router.js';
import { workspaceBoundary } from './workspace.boundary.js';
import { protect } from '../../middleware/auth.middleware.js';
const app=express();app.use(express.json());app.use(cookieParser());app.use(['/api','/uploads'],workspaceBoundary);
app.use('/api/project-workspace',router);app.get('/uploads/file',protect,(req,res)=>res.send('private file'));
app.get('/api/deals',protect,(req,res)=>res.send('legacy deals'));
app.use((e,req,res,next)=>res.status(e.statusCode||500).json({message:e.message}));
const project='9e186c51-79b3-4bf8-8f69-c52a97acf834';
const auth=req=>req.set('Authorization','Bearer '+jwt.sign({id:10},'synthetic-workspace-api-test-only'));
beforeEach(()=>{
 vi.clearAllMocks();vi.stubEnv('JWT_SECRET','synthetic-workspace-api-test-only');vi.stubEnv('PROJECT_WORKSPACE_ENABLED','true');vi.stubEnv('TEST_SUPABASE_URL','https://yaolkwbnhnacxxjpgiyu.supabase.co');
 mocks.findUser.mockResolvedValue({id:10,role:'ADMIN',is_active:1,permissions:['company.project-only','access.v2','inventory.view']});
 mocks.read.mockResolvedValue({records:[{id:1}],has_more:false});
});
describe('workspace route with real auth and global boundary',()=>{
 it('requires verified authentication and never trusts query actor overrides',async()=>{
  expect((await request(app).get('/api/project-workspace/projects')).status).toBe(401);
  expect((await auth(request(app).get(`/api/project-workspace/${project}/units?actor=999`))).status).toBe(400);
  expect(mocks.read).not.toHaveBeenCalled();
 });
 it('passes verified user and exact project/resource to SQL-backed reader',async()=>{
  const r=await auth(request(app).get(`/api/project-workspace/${project}/units/1`));
  expect(r.status).toBe(200);expect(r.headers['cache-control']).toBe('no-store');
  expect(mocks.read).toHaveBeenCalledWith(10,project,'units',{record:'1'});
 });
 it('bounds list parameters and refuses unsupported resources, ID formats and record paging',async()=>{
  for(const path of [`${project}/files`,`${project}/units/../../expenses`,`${project}/units?limit=101`,`${project}/units/1?after=2`,`bad-project/units`,`${project}/units/not-a-number`]){
   const r=await auth(request(app).get('/api/project-workspace/'+path));expect(r.status).toBeGreaterThanOrEqual(400);
  }
  expect(mocks.read).not.toHaveBeenCalled();
 });
 it('blocks all legacy reads and workspace writes, and authenticates local file downloads',async()=>{
  expect((await auth(request(app).get('/api/deals'))).status).toBe(403);
  expect((await auth(request(app).get('/uploads/file'))).status).toBe(403);
  expect((await request(app).get('/uploads/file')).status).toBe(401);
  expect((await auth(request(app).post(`/api/project-workspace/${project}/deals`).send({amount:1}))).status).toBe(403);
  expect(mocks.read).not.toHaveBeenCalled();
 });
 it('does not give a regular unrestricted administrator implicit workspace membership',async()=>{
  mocks.findUser.mockResolvedValue({id:10,role:'ADMIN',is_active:1,permissions:[]});
  expect((await auth(request(app).get('/api/project-workspace/projects'))).status).toBe(403);
  expect(mocks.read).not.toHaveBeenCalled();
 });
});
