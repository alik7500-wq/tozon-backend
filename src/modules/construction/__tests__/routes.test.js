import { describe,it,expect,vi,beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
const state=vi.hoisted(()=>({user:{id:2,role:'MANAGER',permissions:['construction.stock','construction.advance']},db:null}));
vi.mock('../../../middleware/auth.middleware.js',()=>({protect:(req,res,next)=>{req.user=state.user;next();}}));
vi.mock('../../../db/connection.js',()=>({getServiceDB:()=>state.db}));
import router from '../construction.router.js';
const app=express();app.use(express.json());app.use('/construction',router);app.use((e,req,res,next)=>res.status(e.statusCode||500).json({message:e.message}));
const doc={id:'b6064e96-2c4b-47f7-95c9-c26fdfd139b9',kind:'ADVANCE_REPORT',party_id:'b6064e96-2c4b-47f7-95c9-c26fdfd139b8',doc_date:'2026-10-03',currency:'TJS',basis:'Report',lines:[{amount:10,basis:'Delivery',proof:'Receipt'}]};
beforeEach(()=>{state.user={id:2,role:'MANAGER',permissions:['construction.stock','construction.advance']};state.db={from:vi.fn(),rpc:vi.fn()};});
describe('Construction API access boundaries',()=>{
 it('denies access to existing users without explicit construction permissions',async()=>{state.user.permissions=['finance.view'];expect((await request(app).get('/construction/state')).status).toBe(403);expect(state.db.from).not.toHaveBeenCalled();});
 it('storekeeper cannot edit master data or appoint approver',async()=>{expect((await request(app).post('/construction/masters/warehouses').send({name:'Main'})).status).toBe(403);expect((await request(app).patch('/construction/settings').send({approver_user_id:2})).status).toBe(403);});
 it('storekeeper cannot issue money or enter opening balances',async()=>{expect((await request(app).post('/construction/documents').send({...doc,kind:'ADVANCE_ISSUE',amount:10,expense_id:1,lines:[]})).status).toBe(403);expect((await request(app).post('/construction/documents').send({...doc,kind:'OPENING_ADVANCE',amount:10,lines:[]})).status).toBe(403);});
 it('employee cannot create a report for another employee',async()=>{state.db.from.mockReturnValue({select:()=>({eq:()=>({single:async()=>({data:{user_id:3}})})})});expect((await request(app).post('/construction/documents').send(doc)).status).toBe(403);});
 it('mass-assignment of POSTED status is refused before database access',async()=>{expect((await request(app).post('/construction/documents').send({...doc,status:'POSTED'})).status).toBe(400);expect(state.db.from).not.toHaveBeenCalled();});
 it('employee cannot approve their own report even with advance permissions',async()=>{state.db.from.mockImplementation(table=>({select:()=>({eq:()=>({single:async()=>({data:table==='construction_settings'?{approver_user_id:1}:{...doc,status:'SUBMITTED'}})})})}));expect((await request(app).post(`/construction/documents/${doc.id}/post`)).status).toBe(403);expect(state.db.rpc).not.toHaveBeenCalled();});
});
