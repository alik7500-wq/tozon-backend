import {it,expect,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync,readdirSync} from 'node:fs';
import {createHmac,randomUUID} from 'node:crypto';
import express from 'express';
import request from 'supertest';
vi.mock('../../db/connection.js',()=>({getServiceDB:vi.fn()}));
import {BuyerIdentityService} from './identity.service.js';
import {BuyerCommunicationsRepository} from './communications.repository.js';
import {BuyerCommunicationsService} from './communications.service.js';
import {BuyerMaterialsService} from './materials.service.js';
import {BuyerNotificationWorker} from './notification-worker.js';
import {createBuyerRouter} from './router.js';
const botToken='synthetic-acceptance-token',staff={id:1,role:'ADMIN',is_active:true};
function signed(tg){
 const fields={auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:tg})};
 const text=Object.entries(fields).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
 const secret=createHmac('sha256','WebAppData').update(botToken).digest();
 return new URLSearchParams({...fields,hash:createHmac('sha256',secret).update(text).digest('hex')}).toString();
}
it('runs QR → signed HTTP/SMS verification → own finance/document/contact → notification → archive with real CRM SQL',async()=>{
 const db=new PGlite();
 try{
  await db.exec(readFileSync(new URL('./testing/crm-fixture.sql',import.meta.url),'utf8'));
  const directory=new URL('../../../supabase/migrations/',import.meta.url);
  for(const f of readdirSync(directory).filter(f=>f.includes('_buyer_portal_')).sort())await db.exec(readFileSync(new URL(f,directory),'utf8'));
  const rpc=async(name,args)=>{
   if(!/^buyer_portal_[a-z_]+$/.test(name)||Object.keys(args).some(k=>!/^p_[a-z_]+$/.test(k)))throw new Error('Unsafe fixture RPC');
   const names=Object.keys(args),row=(await db.query(`select public.${name}(${names.map((n,i)=>`${n}=>$${i+1}`).join(',')}) data`,Object.values(args))).rows[0];return row.data;
  };
  const repo={
   deal:async id=>(await db.query('select d.id,d.lead_id,d.status,d.responsible_user_id,jsonb_build_object(\'phone\',l.phone) leads from deals d join leads l on l.id=d.lead_id where d.id=$1',[id])).rows[0],
   createInvite:async row=>{const keys=Object.keys(row);return (await db.query(`insert into buyer_portal_invites(${keys.join(',')}) values(${keys.map((_,i)=>'$'+(i+1)).join(',')}) returning id,expires_at`,Object.values(row))).rows[0];},
   prepare:({tokenHash,telegramId,id,codeHash})=>rpc('buyer_portal_prepare_otp',{p_token_hash:tokenHash,p_telegram_id:telegramId,p_id:id,p_code_hash:codeHash}),
   delivered:id=>db.query('update buyer_portal_otp set delivered_at=now() where id=$1',[id]),deliveryFailed:id=>db.query('update buyer_portal_otp set invalidated_at=now() where id=$1',[id]),
   confirm:({id,telegramId,codeHash})=>rpc('buyer_portal_confirm_otp',{p_id:id,p_telegram_id:telegramId,p_code_hash:codeHash}),
   access:tg=>db.query('select * from buyer_portal_access($1)',[tg]).then(r=>r.rows),archiveAccess:tg=>db.query('select * from buyer_portal_archive_access($1)',[tg]).then(r=>r.rows),
   touch:tg=>rpc('buyer_portal_touch',{p_telegram:tg}),
   contractList:tg=>rpc('buyer_portal_contracts',{p_telegram_id:tg}),contractSnapshot:(tg,id)=>rpc('buyer_portal_contract_snapshot',{p_telegram_id:tg,p_deal_id:id}),archiveSnapshot:(tg,id)=>rpc('buyer_portal_archive_snapshot',{p_telegram_id:tg,p_deal_id:id}),
   language:(tg,lang)=>db.query('update buyer_portal_bindings set language=$2 where telegram_id=$1 and revoked_at is null',[tg,lang]),
   materials:(tg,id)=>rpc('buyer_portal_materials',{p_telegram_id:tg,p_deal_id:id}),createDocument:doc=>rpc('buyer_portal_register_document',{p_document:doc}),publishDocument:(deal,id,owner,actor,action)=>rpc('buyer_portal_publish_document',{p_deal_id:deal,p_id:id,p_owner:owner,p_actor:actor,p_action:action})
  };
  const sms={sendSms:vi.fn(async()=>({success:true,isMock:false}))}; // Isolated test transport, never a real provider.
  const identity=new BuyerIdentityService({repo,sms,botIdentity:async()=>({username:'SyntheticTestBot'}),otpSecret:()=> 'synthetic-test-secret-at-least-32-bytes'});
  const commRepo=new BuyerCommunicationsRepository({rpc:async(name,args={})=>{try{return {data:await rpc(name,args)};}catch(error){return {error};}}});
  const communications=new BuyerCommunicationsService({identity,repo:commRepo}),files=new Map();
  const materials=new BuyerMaterialsService({identity,repo,storage:{upload:async(path,buffer)=>files.set(path,buffer),download:async(_bucket,path)=>files.get(path),remove:async path=>files.delete(path)}});
  const app=express();app.use(express.json());app.use(createBuyerRouter(identity,{enabled:()=>true,botToken:()=>botToken,communications,materials}));
  const invite=await identity.createInvite(1,staff),token=invite.url.split('buyer_')[1],auth=signed(101),other=signed(202);
  await request(app).post('/otp').send({token,telegramId:101}).expect(401);
  const otp=await request(app).post('/otp').set('X-Telegram-Init-Data',auth).send({token,telegramId:202}).expect(200);
  const code=/\b\d{6}\b/.exec(sms.sendSms.mock.calls[0][0].text)[0];
  expect(sms.sendSms.mock.calls[0][0].phone).toBe('+992900000001');
  await request(app).post('/verify').set('X-Telegram-Init-Data',other).send({challengeId:otp.body.data.challengeId,code}).expect(400);
  await request(app).post('/verify').set('X-Telegram-Init-Data',auth).send({challengeId:otp.body.data.challengeId,code}).expect(200);
  await request(app).post('/verify').set('X-Telegram-Init-Data',auth).send({challengeId:otp.body.data.challengeId,code}).expect(400);
  const list=await request(app).get('/contracts').set('X-Telegram-Init-Data',auth).expect(200);expect(list.body.data.map(d=>d.id)).toEqual([1]);
  const detail=await request(app).post('/contract').set('X-Telegram-Init-Data',auth).send({dealId:1}).expect(200);expect(detail.body.data.summary).toMatchObject({paidMinor:10000,remainingMinor:90000});expect(JSON.stringify(detail.body)).not.toContain('SECRET');
  await request(app).post('/contract').set('X-Telegram-Init-Data',auth).send({dealId:2}).expect(404);
  const id=await materials.upload(1,staff,{title:'Signed original',kind:'CONTRACT',language:'tj',isSignedOriginal:'true'},{buffer:Buffer.from('%PDF-1.7\nfixture')});
  await request(app).post('/asset').set('X-Telegram-Init-Data',auth).send({dealId:1,type:'DOCUMENT',id}).expect(404);
  await materials.publish(1,id,staff,'PUBLISH');
  await request(app).post('/asset').set('X-Telegram-Init-Data',auth).send({dealId:1,type:'DOCUMENT',id}).expect(200);
  await request(app).post('/asset').set('X-Telegram-Init-Data',other).send({dealId:1,type:'DOCUMENT',id}).expect(404);
  const inquiry=randomUUID();for(let n=0;n<2;n++)await request(app).post('/contact').set('X-Telegram-Init-Data',auth).send({dealId:1,id:inquiry,message:'Когда оформление?'}).expect(200);
  expect((await db.query('select count(*)::int n from tasks')).rows[0].n).toBe(1);
  await communications.reply(1,staff,{id:inquiry,message:'Документы готовы.'});
  const history=await request(app).post('/inquiries').set('X-Telegram-Init-Data',auth).send({dealId:1}).expect(200);expect(history.body.data[0].reply).toBe('Документы готовы.');
  await request(app).patch('/preferences').set('X-Telegram-Init-Data',auth).send({language:'ru'}).expect(200);
  await db.exec("insert into payments(id,deal_id,amount_minor,currency,payment_date,status) values(3,1,5000,'USD','2026-11-14','ACTIVE')");
  const api={send:vi.fn(async()=>{})},worker=new BuyerNotificationWorker({repo:commRepo,identity,api,enabled:()=>true,url:()=> 'https://example.test/buyer',clock:()=>new Date('2026-11-14T07:00:00Z'),logger:{warn:vi.fn()}});
  await worker.tick();expect(api.send.mock.calls.some(([,text])=>text.includes('Ваш платёж принят.')&&text.includes('150 USD')&&text.includes('850 USD'))).toBe(true);
  const notices=await request(app).get('/notices').set('X-Telegram-Init-Data',auth).expect(200);expect(notices.body.data.length).toBeGreaterThan(0);
  expect((await communications.staffNotices(1,staff)).some(n=>n.kind==='PAYMENT'&&n.status==='SENT')).toBe(true);
  expect((await db.query('select last_active_at from buyer_portal_bindings where telegram_id=101')).rows[0].last_active_at).not.toBeNull();
  await db.exec("update deals set status='CANCELLED',terminated_by_user_id=1,cancelled_at=now() where id=1");
  const archive=await request(app).post('/contract').set('X-Telegram-Init-Data',auth).send({dealId:1}).expect(200);expect(archive.body.data).toMatchObject({archived:true,summary:{remainingMinor:null,overdueMinor:null,nextPayment:null}});
  await request(app).patch('/preferences').set('X-Telegram-Init-Data',auth).send({language:'tj'}).expect(200);
  await materials.publish(1,id,staff,'REVOKE');await request(app).post('/asset').set('X-Telegram-Init-Data',auth).send({dealId:1,type:'DOCUMENT',id}).expect(404);
 }finally{await db.close();}
},20000);
