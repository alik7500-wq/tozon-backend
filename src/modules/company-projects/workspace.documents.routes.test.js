import {beforeEach,it,expect,vi} from 'vitest';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
const m=vi.hoisted(()=>({user:vi.fn(),authorize:vi.fn(),details:vi.fn(),files:vi.fn(),upload:vi.fn(),download:vi.fn(),template:vi.fn(),read:vi.fn(),card:vi.fn()}));
vi.mock('../users/users.repository.js',()=>({UsersRepository:{findById:m.user}}));
vi.mock('../../db/connection.js',()=>({getServiceDB:vi.fn()}));
vi.mock('./workspace.repository.js',()=>({readWorkspace:vi.fn(),readWorkspaceOptions:vi.fn()}));
vi.mock('./workspace.documents.js',()=>({authorizeDocument:m.authorize,documentDetails:m.details,readFiles:m.files,uploadFile:m.upload,downloadFile:m.download,downloadTemplate:m.template,readDocument:m.read,printableCard:m.card,FILE_LIMIT:10*1024*1024}));
import router from './workspace.router.js';
import {workspaceBoundary} from './workspace.boundary.js';
const app=express();app.use(express.json());app.use(cookieParser());app.use('/api',workspaceBoundary);app.use('/api/project-workspace',router);app.use((e,req,res,next)=>res.status(e.statusCode||500).json({message:e.message}));
const project='00000000-0000-4000-8000-000000000001',file='00000000-0000-4000-8000-000000000002',base=`/api/project-workspace/${project}/documents/1`;
const auth=r=>r.set('Authorization','Bearer '+jwt.sign({id:10},'document-route-test-secret'));
beforeEach(()=>{
 vi.clearAllMocks();for(const flag of ['PROJECT_WORKSPACE_ENABLED','PROJECT_WORKSPACE_WRITES_ENABLED','PROJECT_WORKSPACE_FILES_ENABLED','PROJECT_WORKSPACE_DOCUMENTS_ENABLED'])vi.stubEnv(flag,'true');vi.stubEnv('TEST_SUPABASE_URL','https://yaolkwbnhnacxxjpgiyu.supabase.co');vi.stubEnv('JWT_SECRET','document-route-test-secret');vi.stubEnv('FRONTEND_ORIGIN','https://trusted.example');m.user.mockResolvedValue({id:10,is_active:1,role:'ADMIN',permissions:['company.project-only']});m.details.mockResolvedValue({deal:{id:1}});m.authorize.mockResolvedValue(null);m.upload.mockResolvedValue({id:file});m.download.mockResolvedValue({buffer:Buffer.from('%PDF-test'),type:'application/pdf',name:'Договор.pdf'});
});
it('passes the verified actor, project and deal and refuses client context overrides',async()=>{
 expect((await auth(request(app).get(base))).status).toBe(200);expect(m.details).toHaveBeenCalledWith(10,project,1);
 expect((await auth(request(app).get(base+'?actor=20'))).status).toBe(400);
 expect((await auth(request(app).get(base+'/word/CONTRACT/RU?director_name=Forged'))).status).toBe(400);expect(m.template).not.toHaveBeenCalled();
});
it('serves binary only after scoped authorization and sends no-cache, attachment and nosniff headers',async()=>{
 const r=await auth(request(app).get(base+'/files/'+file));expect(r.status).toBe(200);expect(m.download).toHaveBeenCalledWith(10,project,1,file);expect(r.headers['content-disposition']).toContain('attachment');expect(r.headers['content-disposition']).toContain("filename*=UTF-8''");expect(r.headers['cache-control']).toContain('no-store');expect(r.headers['x-content-type-options']).toBe('nosniff');
});
it('keeps both documents and uploads off behind independent flags',async()=>{
 vi.stubEnv('PROJECT_WORKSPACE_DOCUMENTS_ENABLED','false');expect((await auth(request(app).get(base))).status).toBe(403);expect(m.details).not.toHaveBeenCalled();
 vi.stubEnv('PROJECT_WORKSPACE_DOCUMENTS_ENABLED','true');vi.stubEnv('PROJECT_WORKSPACE_FILES_ENABLED','false');expect((await auth(request(app).post(base+'/files')).set('X-Request-ID',file).attach('file',Buffer.from('%PDF-test'),'a.pdf')).status).toBe(403);expect(m.upload).not.toHaveBeenCalled();
});
it('requires an exact cookie Origin, upload UUID and project grant before handling multipart data',async()=>{
 const cookie='jwt='+jwt.sign({id:10},'document-route-test-secret');
 expect((await request(app).post(base+'/files').set('Cookie',cookie).set('Origin','https://foreign.example').set('X-Request-ID',file).attach('file',Buffer.from('pdf'),'a.pdf')).status).toBe(403);expect(m.authorize).not.toHaveBeenCalled();
 expect((await auth(request(app).post(base+'/files')).attach('file',Buffer.from('pdf'),'a.pdf')).status).toBe(400);
 const r=await auth(request(app).post(base+'/files')).set('X-Request-ID',file).attach('file',Buffer.from('%PDF-test'),'a.pdf');expect(r.status).toBe(201);expect(m.authorize).toHaveBeenCalledWith(10,project,1,true);expect(m.upload).toHaveBeenCalledWith(10,project,1,file,expect.objectContaining({originalname:'a.pdf'}));
});

it('blocks cross-origin cookie reads despite permissive app CORS and forged bearer headers',async()=>{
 const cookie='jwt='+jwt.sign({id:10},'document-route-test-secret');
 expect((await request(app).get(base).set('Cookie',cookie).set('Authorization','Bearer forged').set('Origin','https://foreign.example')).status).toBe(403);expect(m.details).not.toHaveBeenCalled();
 expect((await request(app).get(base).set('Cookie',cookie).set('Origin','https://trusted.example')).status).toBe(200);
});
