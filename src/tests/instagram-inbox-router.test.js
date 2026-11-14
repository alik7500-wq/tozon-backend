import { describe,it,expect,vi,beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
const mocks=vi.hoisted(()=>({credentials:vi.fn(),list:vi.fn(),messages:vi.fn(),send:vi.fn()}));
vi.mock('../modules/integrations/instagram-connection.repository.js',()=>({getInstagramInboxCredentials:mocks.credentials}));
vi.mock('../modules/integrations/instagram-inbox.client.js',async importOriginal=>({...await importOriginal(),createInstagramInboxClient:()=>({conversations:mocks.list,messages:mocks.messages,send:mocks.send})}));
vi.mock('../middleware/auth.middleware.js',()=>({protect:async(req,res,next)=>{
 if(!req.headers['x-role'])return res.sendStatus(401);
 req.user={id:'1',role:req.headers['x-role'],permissions:['access.v2',...(req.headers['x-grants']||'').split(',')]};
 try{await authorizeSectionRequest(req);next();}catch{return res.sendStatus(403);}
}}));
import {authorizeSectionRequest} from '../middleware/sectionAccess.js';
import router from '../modules/integrations/instagram-inbox.router.js';
const app=express();app.use(express.json());app.use('/api/integrations/instagram',router);
const path='/api/integrations/instagram/inbox/conversations';
beforeEach(()=>{vi.clearAllMocks();mocks.credentials.mockResolvedValue({accountId:'17841447499018452',token:'secret'});mocks.list.mockResolvedValue({data:[],nextCursor:null});});
describe('Direct authenticated routes and real permission matrix',()=>{
 it('rejects anonymous and finance users before loading token',async()=>{
  expect((await request(app).get(path)).status).toBe(401);
  expect((await request(app).get(path).set('x-role','FINANCE_MANAGER').set('x-grants','leads.view')).status).toBe(403);
  expect(mocks.credentials).not.toHaveBeenCalled();
 });
 it('requires leads view even for matrix administrators',async()=>{
  expect((await request(app).get(path).set('x-role','ADMIN')).status).toBe(403);
 });
 it('allows administrators with CRM read permission and returns actual empty success',async()=>{
  const r=await request(app).get(path).set('x-role','ADMIN').set('x-grants','leads.view');
  expect(r.status).toBe(200);expect(r.body).toEqual({status:'success',data:[],nextCursor:null});
  expect(r.headers['cache-control']).toBe('no-store');
 });
 it('requires CRM manage permission for sending',async()=>{
  const r=await request(app).post('/api/integrations/instagram/send/17841447499018452/999').set('x-role','DIRECTOR').set('x-grants','leads.view').send({text:'hi'});
  expect(r.status).toBe(403);expect(mocks.send).not.toHaveBeenCalled();
 });
 it('rejects a foreign account before Graph access',async()=>{
  const r=await request(app).get(path+'/11111/999/messages').set('x-role','ADMIN').set('x-grants','leads.view');
  expect(r.status).toBe(404);expect(mocks.messages).not.toHaveBeenCalled();
 });
 it('does not report disconnected as an empty inbox',async()=>{
  mocks.credentials.mockResolvedValue(null);
  const r=await request(app).get(path).set('x-role','ADMIN').set('x-grants','leads.view');
  expect(r.status).toBe(409);expect(r.body.code).toBe('INSTAGRAM_RECONNECT_REQUIRED');
 });
 it('sanitizes unexpected errors',async()=>{
  mocks.list.mockRejectedValue(new Error('token secret'));
  const r=await request(app).get(path).set('x-role','ADMIN').set('x-grants','leads.view');
  expect(r.status).toBe(503);expect(JSON.stringify(r.body)).not.toContain('token secret');
 });
 it('selects credentials for the requested registered account and rejects malformed selectors',async()=>{
  mocks.credentials.mockResolvedValue({accountId:'22222',token:'second-account-token'});
  const r=await request(app).get(path).query({account:'22222'}).set('x-role','ADMIN').set('x-grants','leads.view');
  expect(r.status).toBe(200);expect(mocks.credentials).toHaveBeenCalledWith('22222');
  expect(JSON.stringify(r.body)).not.toContain('second-account-token');
  mocks.credentials.mockClear();
  expect((await request(app).get(path).query({account:['11111','22222']}).set('x-role','ADMIN').set('x-grants','leads.view')).status).toBe(400);
  expect(mocks.credentials).not.toHaveBeenCalled();
 });
 it('never opens or sends from an unconnected account',async()=>{
  mocks.credentials.mockResolvedValue(null);
  const r=await request(app).get(path+'/22222/999/messages').set('x-role','ADMIN').set('x-grants','leads.view');
  expect(r.status).toBe(404);expect(mocks.messages).not.toHaveBeenCalled();
 });
});
