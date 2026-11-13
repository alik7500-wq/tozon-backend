import { beforeEach, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
vi.mock('../../db/connection.js',()=>({getServiceDB:vi.fn()}));
import { createBuyerRouter } from './router.js';
import { BuyerPortalError } from './identity.service.js';
const botToken='test-only-token';
function auth(id=101) {
  const fields={auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id})};
  const check=Object.entries(fields).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
  const key=createHmac('sha256','WebAppData').update(botToken).digest();
  return new URLSearchParams({...fields,hash:createHmac('sha256',key).update(check).digest('hex')}).toString();
}
let app,service,materials;
beforeEach(()=>{
  service={requestCode:vi.fn(async()=>({challengeId:'safe'})),confirmCode:vi.fn(async()=>({verified:true})),contracts:vi.fn(async()=>[]),preferences:vi.fn(async()=>({language:'ru'})),contractList:vi.fn(async()=>[]),contract:vi.fn(async()=>({id:1}))};
  materials={manifest:vi.fn(async()=>({plans:[],documents:[],tour:null})),asset:vi.fn(async()=>({buffer:Buffer.from('%PDF-1.7'),mime:'application/pdf',filename:'TOZON-document.pdf'}))};
  app=express(); app.use(express.json()); app.use(createBuyerRouter(service,{enabled:()=>true,botToken:()=>botToken,materials}));
});
it('rejects staff JWTs and unsigned Telegram IDs as buyer authentication',async()=>{
  await request(app).post('/otp').set('Authorization','Bearer staff-token').send({telegramId:101,token:'x'}).expect(401);
  expect(service.requestCode).not.toHaveBeenCalled();
});
it('uses only the signed identity, ignoring IDs supplied in request payload',async()=>{
  await request(app).post('/otp').set('X-Telegram-Init-Data',auth()).send({token:'opaque',telegramId:202,leadId:999,dealId:888}).expect(200);
  expect(service.requestCode).toHaveBeenCalledWith('opaque','101');
  await request(app).post('/verify').set('X-Telegram-Init-Data',auth()).send({challengeId:'one',code:'123456',telegramId:202}).expect(200);
  expect(service.confirmCode).toHaveBeenCalledWith('one','123456','101');
});
it('checks authentication on every request and marks responses private',async()=>{
  const response=await request(app).get('/access?telegramId=202').set('X-Telegram-Init-Data',auth()).expect(200);
  expect(service.contracts).toHaveBeenCalledWith('101');
  expect(response.headers['cache-control']).toBe('no-store');
  await request(app).get('/access').expect(401);
});
it('hides provider and database errors',async()=>{
  service.requestCode.mockRejectedValue(new Error('secret DB error and phone'));
  const response=await request(app).post('/otp').set('X-Telegram-Init-Data',auth()).send({token:'x'}).expect(503);
  expect(response.body).toEqual({message:'BUYER_SERVICE_UNAVAILABLE'});
});
it('returns expected throttling without leaking internals',async()=>{
  service.requestCode.mockRejectedValue(new BuyerPortalError('BUYER_OTP_RATE_LIMITED',429));
  await request(app).post('/otp').set('X-Telegram-Init-Data',auth()).send({token:'x'}).expect(429);
});
it('is disabled by default until controlled rollout',async()=>{
  const disabled=express(); disabled.use(createBuyerRouter(service,{enabled:()=>false}));
  await request(disabled).post('/otp').expect(404);
  expect(service.requestCode).not.toHaveBeenCalled();
});
it('updates preferences using only the signed identity',async()=>{
  await request(app).patch('/preferences').set('X-Telegram-Init-Data',auth()).send({language:'ru',telegramId:202}).expect(200);
  expect(service.preferences).toHaveBeenCalledWith('101','ru');
});
it('uses signed identity on every financial read, even when payload tries to impersonate another buyer',async()=>{
  await request(app).get('/contracts?telegramId=202').set('X-Telegram-Init-Data',auth()).expect(200);
  expect(service.contractList).toHaveBeenCalledWith('101');
  await request(app).post('/contract').set('X-Telegram-Init-Data',auth()).send({dealId:1,telegramId:202,leadId:999}).expect(200);
  expect(service.contract).toHaveBeenCalledWith('101',1);
  await request(app).post('/contract').send({dealId:1}).expect(401);
});
it('authenticates binary downloads and sends private attachment headers without a public URL',async()=>{
 await request(app).post('/asset').send({dealId:1,type:'DOCUMENT',id:'x'}).expect(401);
 const response=await request(app).post('/asset').set('X-Telegram-Init-Data',auth()).send({dealId:1,type:'DOCUMENT',id:'x',telegramId:202}).expect(200);
 expect(materials.asset).toHaveBeenCalledWith('101',expect.objectContaining({dealId:1,id:'x'}));
 expect(response.headers['content-type']).toBe('application/pdf');expect(response.headers['cache-control']).toBe('no-store');expect(response.headers['x-content-type-options']).toBe('nosniff');
 expect(response.headers['content-disposition']).toContain('attachment');
 await request(app).post('/materials').set('X-Telegram-Init-Data',auth()).send({dealId:1,telegramId:202}).expect(200);
 expect(materials.manifest).toHaveBeenCalledWith('101',1);
});
