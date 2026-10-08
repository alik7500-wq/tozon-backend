import {describe,it,expect,vi,beforeEach} from 'vitest';
import express from 'express';
import request from 'supertest';
import PizZip from 'pizzip';
import {sampleTemplate} from './template.engine.js';
const state=vi.hoisted(()=>({db:vi.fn()}));
vi.mock('../../db/connection.js',()=>({getServiceDB:state.db}));
vi.mock('../../middleware/auth.middleware.js',()=>({
 protect:(req,res,next)=>{if(!req.headers['x-test-role'])return res.sendStatus(401);req.user={id:1,role:req.headers['x-test-role']};next();},
 restrictTo:(...roles)=>(req,res,next)=>roles.includes(req.user.role)?next():res.sendStatus(403)
}));
import router,{settingsSchema} from './document-settings.router.js';
const app=express();app.use(express.json());app.use('/settings',router);app.use((e,req,res,next)=>res.status(e.statusCode||500).json({message:e.message}));
beforeEach(()=>vi.clearAllMocks());
describe('document-settings authorization and validation',()=>{
 it('requires authentication',async()=>{expect((await request(app).get('/settings/templates')).status).toBe(401);expect(state.db).not.toHaveBeenCalled();});
 it.each(['/configuration','/templates/not-a-uuid/activate','/templates/not-a-uuid/disable'])('denies staff configuration mutation %s',async path=>{
   const r=path==='/configuration'?await request(app).put('/settings'+path).set('x-test-role','MANAGER').send({}):await request(app).post('/settings'+path).set('x-test-role','MANAGER');expect(r.status).toBe(403);expect(state.db).not.toHaveBeenCalled();
 });
 it('denies staff access to original template and configuration history',async()=>{
   for(const path of ['/configuration/history','/templates/7a3784a1-90c5-46ad-bace-77d451bb13b7/download'])expect((await request(app).get('/settings'+path).set('x-test-role','MANAGER')).status).toBe(403);
 });
 it('rejects unknown settings, unsafe masks and out-of-range rules',()=>{
   for(const input of [{unknown:true},{numbering:{CONTRACT:'ABC'}},{numbering:{CONTRACT:'{id}-{bad}'}},{numbering:{PKO:'{project_code}-{id}'}},{reservation_days:0},{max_discount_percent:101}])expect(()=>settingsSchema.parse(input)).toThrow();
   expect(settingsSchema.parse({numbering:{CONTRACT:'TZ-{year}-{id4}',PKO:'ПКО-{id}',RKO:''}}).reservation_days).toBe(3);
 });
 it('fails invalid upload before any DB mutation',async()=>{
   const r=await request(app).post('/settings/templates').set('x-test-role','ADMIN').field('kind','CONTRACT').field('language','TJ').attach('file',Buffer.from('fake'),'bad.docx');expect(r.status).toBe(400);expect(state.db).not.toHaveBeenCalled();
 });
 it('renders active template using saved company values and response without caching',async()=>{
   let call=0;
   state.db.mockImplementation(()=>({from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{kind:'CONTRACT',active:true,file_base64:sampleTemplate('CONTRACT').toString('base64')}}),single:async()=>({data:{data:{company:{company_name:'Saved company',company_phone:''}}}})})})})}));
   const r=await request(app).post('/settings/render/7a3784a1-90c5-46ad-bace-77d451bb13b7').set('x-test-role','MANAGER').send({company_name:'Forged company',client_name:'Synthetic client',contract_number:'0042'}).buffer(true).parse((res,cb)=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>cb(null,Buffer.concat(chunks)));});
   expect(r.status).toBe(200);expect(r.headers['cache-control']).toBe('no-store');
   const xml=new PizZip(r.body).file('word/document.xml').asText();expect(xml).toContain('Saved company');expect(xml).not.toContain('Forged company');expect(xml).toContain('0042');
 });
});
