import { beforeEach,describe,it,expect,vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';
const mocks=vi.hoisted(()=>({findUser:vi.fn(),read:vi.fn(),command:vi.fn(),options:vi.fn(),overview:vi.fn(),inventory:vi.fn()}));
vi.mock('../users/users.repository.js',()=>({UsersRepository:{findById:mocks.findUser}}));
vi.mock('./workspace.commands.js',async original=>{const actual=await original();return {...actual,executeWorkspaceCommand:mocks.command};});
vi.mock('./workspace.repository.js',()=>({readWorkspace:mocks.read,readWorkspaceOptions:mocks.options,readWorkspaceInventory:mocks.inventory,readWorkspaceOverview:mocks.overview}));
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
 vi.clearAllMocks();vi.stubEnv('PROJECT_WORKSPACE_WRITES_ENABLED','false');vi.stubEnv('JWT_SECRET','synthetic-workspace-api-test-only');vi.stubEnv('PROJECT_WORKSPACE_ENABLED','true');vi.stubEnv('TEST_SUPABASE_URL','https://yaolkwbnhnacxxjpgiyu.supabase.co');
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
 it('accepts only the reviewed command endpoint with a separate write flag and authenticated actor',async()=>{
  vi.stubEnv('PROJECT_WORKSPACE_WRITES_ENABLED','true');
  mocks.command.mockResolvedValue({id:1,resource:'payments',idempotent:false});
  const body={request_id:project,kind:'PAYMENT',payload:{cash_desk_id:project,deal_id:1,amount_minor:100,currency:'USD',date:'2026-11-10'}};
  const r=await auth(request(app).post(`/api/project-workspace/${project}/commands`).send(body));
  expect(r.status).toBe(201);expect(mocks.command).toHaveBeenCalledWith(10,project,expect.objectContaining({kind:'PAYMENT'}));
  expect((await auth(request(app).post('/api/deals').send(body))).status).toBe(403);
 });
 it('requires the exact trusted origin for cookie-authenticated writes, even with a forged bearer header',async()=>{
  vi.stubEnv('PROJECT_WORKSPACE_WRITES_ENABLED','true');vi.stubEnv('FRONTEND_ORIGIN','https://trusted.example');
  const cookie='jwt='+jwt.sign({id:10},'synthetic-workspace-api-test-only');
  const body={request_id:project,kind:'PAYMENT',payload:{cash_desk_id:project,deal_id:1,amount_minor:100,currency:'USD',date:'2026-11-10'}};
  const r=await request(app).post(`/api/project-workspace/${project}/commands`).set('Cookie',cookie).set('Authorization','Bearer forged').set('Origin','https://attacker.example').send(body);
  expect(r.status).toBe(403);expect(mocks.command).not.toHaveBeenCalled();
  mocks.command.mockResolvedValue({id:1,resource:'payments',idempotent:true});
  expect((await request(app).post(`/api/project-workspace/${project}/commands`).set('Cookie',cookie).set('Origin','https://trusted.example').send(body)).status).toBe(200);
 });

 it('loads scoped operation options through verified identity and hides actions while writes are disabled',async()=>{
  mocks.options.mockResolvedValue({commands:['SIGN_DEAL'],project_id:project});
  let r=await auth(request(app).get(`/api/project-workspace/${project}/options`));
  expect(r.status).toBe(200);expect(r.body.data.commands).toEqual([]);expect(mocks.options).toHaveBeenCalledWith(10,project,'context',{});
  vi.stubEnv('PROJECT_WORKSPACE_WRITES_ENABLED','true');mocks.options.mockResolvedValue({commands:['SIGN_DEAL'],project_id:project});
  r=await auth(request(app).get(`/api/project-workspace/${project}/options`));expect(r.body.data.commands).toEqual(['SIGN_DEAL']);
  expect((await auth(request(app).get(`/api/project-workspace/${project}/options/materials?limit=101`))).status).toBe(400);
  expect((await auth(request(app).get(`/api/project-workspace/${project}/options?actor=2`))).status).toBe(400);
 });
 it('accepts the dedicated signing command and rejects client-supplied price or actor',async()=>{
  vi.stubEnv('PROJECT_WORKSPACE_WRITES_ENABLED','true');mocks.command.mockResolvedValue({id:1,resource:'deals',status:'SIGNED'});
  const body={request_id:project,kind:'SIGN_DEAL',payload:{deal_id:1,expected_updated_at:'version',down_payment_minor:0,installment_months:36}};
  expect((await auth(request(app).post(`/api/project-workspace/${project}/commands`).send(body))).status).toBe(201);
  expect((await auth(request(app).post(`/api/project-workspace/${project}/commands`).send({...body,payload:{...body.payload,final_price_minor:1}}))).status).toBe(400);
 });

 it('validates separate cancellation and termination payloads without accepting forged status or actor',async()=>{
  vi.stubEnv('PROJECT_WORKSPACE_WRITES_ENABLED','true');mocks.command.mockResolvedValue({id:1,resource:'deals',status:'CANCELLED'});
  const body={request_id:project,kind:'CANCEL_DRAFT',payload:{deal_id:1,expected_updated_at:'version',reason:'Клиент отказался'}};
  expect((await auth(request(app).post(`/api/project-workspace/${project}/commands`).send(body))).status).toBe(201);
  expect((await auth(request(app).post(`/api/project-workspace/${project}/commands`).send({...body,payload:{...body.payload,status:'CANCELLED'}}))).status).toBe(400);
  expect((await auth(request(app).post(`/api/project-workspace/${project}/commands`).send({...body,kind:'TERMINATE_UNPAID'}))).status).toBe(400);
  expect((await auth(request(app).post(`/api/project-workspace/${project}/commands`).send({...body,kind:'TERMINATE_UNPAID',payload:{...body.payload,basis:'Соглашение № 1',basis_date:'2026-11-10'}}))).status).toBe(201);
 });

});

it('loads overview only for the authenticated scoped actor and refuses actor overrides',async()=>{
 mocks.overview.mockResolvedValue({inventory:{available:150}});const r=await auth(request(app).get(`/api/project-workspace/${project}/overview`));expect(r.status).toBe(200);expect(r.headers['cache-control']).toBe('no-store');expect(mocks.overview).toHaveBeenCalledWith(10,project);
 expect((await auth(request(app).get(`/api/project-workspace/${project}/overview?actor=30`))).status).toBe(400);
 mocks.findUser.mockResolvedValue({id:30,role:'ADMIN',is_active:1,permissions:[]});expect((await auth(request(app).get(`/api/project-workspace/${project}/overview`))).status).toBe(403);expect(mocks.overview).toHaveBeenCalledTimes(1);
});

it('uses authenticated actor for inventory and validates complex selector strictly',async()=>{
 mocks.inventory.mockResolvedValue({records:[],complexes:[]});let r=await auth(request(app).get(`/api/project-workspace/${project}/inventory?complex_id=3`));expect(r.status).toBe(200);expect(mocks.inventory).toHaveBeenCalledWith(10,project,3);
 for(const query of ['actor=30','complex_id=-1','complex_id=0','complex_id=2147483648','complex_id=1&complex_id=2'])expect((await auth(request(app).get(`/api/project-workspace/${project}/inventory?${query}`))).status).toBe(400);
 expect(mocks.inventory).toHaveBeenCalledTimes(1);
});
it('prepares an offer without writes and rejects forged fields, missing print rights and cookie origins',async()=>{
 vi.stubEnv('PROJECT_WORKSPACE_DOCUMENTS_ENABLED','true');vi.stubEnv('FRONTEND_ORIGIN','https://trusted.example');
 mocks.read.mockResolvedValue({projects:[{id:project,name:'Plaza',sections:['inventory.view','documents.print']}]});
 mocks.inventory.mockResolvedValue({records:[{id:1,unit_kind:'APARTMENT',unit_number:'101',area_m2_x100:6000,price_per_m2_minor:70000,status:'AVAILABLE'}],complexes:[{id:3,name:'Own',currency:'USD'}],schemes:[]});
 const body={complex_id:3,unit_id:1,language:'RU',expected_unit_price_minor:70000,expected_area_x100:6000,expected_total_minor:4200000,scheme_id:null,scheme_updated_at:null,rule_key:null,down_payment_minor:0,installment_months:36,reference_rate:null};
 const path=`/api/project-workspace/${project}/offers/preview`;
 const r=await auth(request(app).post(path).send(body));expect(r.status).toBe(200);expect(r.headers['cache-control']).toBe('no-store');expect(r.body.data.quote.total_minor).toBe(4200000);expect(mocks.command).not.toHaveBeenCalled();
 expect((await auth(request(app).post(path.replace('/preview','/save')).send(body))).status).toBe(403);
 vi.stubEnv('PROJECT_WORKSPACE_DOCUMENTS_ENABLED','false');expect((await auth(request(app).post(path).send(body))).status).toBe(403);vi.stubEnv('PROJECT_WORKSPACE_DOCUMENTS_ENABLED','true');
 expect((await auth(request(app).post(path).send({...body,actor:20}))).status).toBe(400);
 expect((await auth(request(app).post(path+'?actor=20').send(body))).status).toBe(400);
 const cookie='jwt='+jwt.sign({id:10},'synthetic-workspace-api-test-only');expect((await request(app).post(path).set('Cookie',cookie).set('Origin','https://evil.example').send(body)).status).toBe(403);
 mocks.read.mockResolvedValue({projects:[]});expect((await auth(request(app).post(path).send(body))).status).toBe(403);
});
