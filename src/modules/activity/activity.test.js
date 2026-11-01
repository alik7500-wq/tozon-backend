import {it,expect,vi,beforeEach}from'vitest';
import express from'express';import request from'supertest';
const mocks=vi.hoisted(()=>({user:{id:1,name:'Руководитель',role:'ADMIN'},from:vi.fn(),insert:vi.fn(),upsert:vi.fn(),tables:{}}));
vi.mock('../../db/connection.js',()=>({getServiceDB:()=>({from:mocks.from})}));
vi.mock('../../middleware/auth.middleware.js',()=>({protect:(req,res,next)=>{req.user=mocks.user;next()}}));
import router from'./activity.router.js';import{describeRequest,activityMiddleware}from'./activity.middleware.js';
const app=express();app.use(express.json());app.use('/api/auth/activity',router);app.use((e,req,res,next)=>res.status(e.statusCode||500).json({message:e.message}));
beforeEach(()=>{vi.clearAllMocks();mocks.user={id:1,name:'Руководитель',role:'ADMIN'};mocks.tables={users:[],crm_user_presence:[],crm_activity_events:[]};mocks.insert.mockResolvedValue({error:null});mocks.upsert.mockResolvedValue({error:null});mocks.from.mockImplementation(table=>{const q={select:()=>q,order:()=>q,limit:()=>q,eq:()=>q,lt:()=>q,gte:()=>q,lte:()=>q,maybeSingle:()=>Promise.resolve({data:(mocks.tables[table]||[])[0]||null,error:null}),insert:mocks.insert,upsert:mocks.upsert,then:resolve=>resolve({data:mocks.tables[table]||[],error:null})};return q;});});
it('describes changes without retaining credentials, query terms or field values',()=>{
 const event=describeRequest({originalUrl:'/api/finance/expenses/536?search=private',method:'PATCH',body:{amount:500,password:'secret',token:'token',description:'private client data'}},200);
 expect(event).toMatchObject({kind:'UPDATE',entity_id:'536',resource:'Финансы',changed_fields:['amount'],outcome:'SUCCESS'});
 expect(JSON.stringify(event)).not.toMatch(/secret|private|token|500/);
 expect(describeRequest({originalUrl:'/api/auth/activity/heartbeat',method:'POST',body:{}},200)).toBeNull();
 expect(describeRequest({originalUrl:'/api/deals',method:'GET'},200)).toBeNull();
 expect(describeRequest({originalUrl:'/api/deals/77?search=private',method:'GET'},200)).toMatchObject({kind:'VIEW',entity_id:'77'});
});
it('does not expose staff presence or history to managers even with broad section permissions',async()=>{
 mocks.user={id:2,role:'SALES_MANAGER',permissions:['*','users.manage']};
 expect((await request(app).get('/api/auth/activity')).status).toBe(403);expect(mocks.from).not.toHaveBeenCalled();
});
it('binds heartbeat actor to authentication and ignores forged identity and section',async()=>{
 mocks.user={id:2,name:'Менеджер',role:'SALES_MANAGER'};
 expect((await request(app).post('/api/auth/activity/heartbeat').send({user_id:1,section:'секрет/номер123'})).status).toBe(200);
 expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({user_id:2,current_section:'Обзор',last_logout_at:null}),expect.anything());
 expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({user_id:2,kind:'VIEW',actor_name:'Менеджер'}));
});
it('counts online unique active accounts and respects explicit logout and deactivation',async()=>{
 const now=new Date().toISOString();mocks.tables.users=[{id:1,name:'Один',is_active:1},{id:2,name:'Два',is_active:1},{id:3,name:'Три',is_active:0}];mocks.tables.crm_user_presence=[{user_id:1,last_seen_at:now},{user_id:2,last_seen_at:now,last_logout_at:now},{user_id:3,last_seen_at:now}];
 const r=await request(app).get('/api/auth/activity');expect(r.status).toBe(200);expect(r.body.data.online_count).toBe(1);expect(r.body.data.visited_today).toBe(3);
});
it('rejects malformed filters before reading history',async()=>{
 for(const query of ['user_id=1%20or%201=1','kind=UNKNOWN','from=2026-02-31','from=2026-11-02&to=2026-11-01'])expect((await request(app).get('/api/auth/activity?'+query)).status).toBe(400);
 expect(mocks.from).not.toHaveBeenCalled();
});
it('records completed mutation and returned entity ID after response, without request values',async()=>{
 const audit=express();audit.use(express.json());audit.use(activityMiddleware);audit.post('/api/deals',(req,res)=>{req.user=mocks.user;res.status(201).json({data:{deal:{id:77}}});});
 await request(audit).post('/api/deals').send({password:'never log',final_price_minor:10000});
 await vi.waitFor(()=>expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({entity_id:'77',kind:'CREATE',http_status:201,changed_fields:['final_price_minor']})));
 expect(JSON.stringify(mocks.insert.mock.calls)).not.toContain('never log');
});
