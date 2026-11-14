import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
let db;
const binding='11111111-1111-4111-8111-111111111111',worker=randomUUID();
beforeAll(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table users(id integer primary key,role text,is_active integer);
 create table leads(id integer primary key,phone text);
 create table deals(id integer primary key,lead_id integer,status text,unit_id integer,responsible_user_id integer,contract_number text,final_price_minor integer,down_payment_minor integer,first_payment_date date,payment_type text);
 create table payments(id integer primary key,deal_id integer,amount_minor integer,currency text,amount_usd numeric,amount_tjs numeric,exchange_rate numeric,status text,operation_type text default 'STANDARD',settlement_method text default 'CASH',transfer_id uuid,conversion_id uuid);
 create table deal_payment_schedules(id integer primary key,deal_id integer,due_date date,amount_minor integer,paid_amount_minor integer,status text);
 create table tasks(id serial primary key,lead_id integer,deal_id integer,assigned_user_id integer,type text,title text,description text,due_date text,priority text,status text,idempotency_key text,updated_at timestamptz,completed_at timestamptz);
 create unique index tasks_open_type on tasks(deal_id,type) where status='OPEN' and deal_id is not null;
 create table buyer_portal_documents(id uuid primary key,deal_id integer,owner_lead_id integer,status text,sha256 text,is_signed_original boolean,kind text,language text);
 insert into users values(1,'ADMIN',1),(2,'SALES_MANAGER',1),(3,'SALES_MANAGER',1);
 insert into leads values(1,'+992900000001'),(2,'+992900000002');
 insert into deals values(1,1,'SIGNED',1,2,'001',100000,0,null,'INSTALLMENT'),(2,2,'SIGNED',2,3,'002',100000,0,null,'INSTALLMENT');
 grant select,insert,update on all tables in schema public to service_role;
 grant usage,select on all sequences in schema public to service_role;`);
 for(const f of ['20261113195039_buyer_portal_identity.sql','20261114060708_buyer_portal_communications.sql'])await db.exec(readFileSync(new URL('../../../supabase/migrations/'+f,import.meta.url),'utf8'));
},20000);
beforeEach(async()=>{
 await db.exec(`truncate buyer_portal_notices,buyer_portal_inquiries,buyer_portal_grants,buyer_portal_bindings,buyer_portal_invites,buyer_portal_otp,buyer_portal_audit,payments,deal_payment_schedules,buyer_portal_documents,tasks cascade;
 update deals set lead_id=id,responsible_user_id=case when id=1 then 2 else 3 end,status='SIGNED',final_price_minor=100000;
 insert into buyer_portal_bindings(id,lead_id,telegram_id,phone_snapshot) values('${binding}',1,101,'+992900000001');
 insert into buyer_portal_grants(binding_id,deal_id,owner_lead_id) values('${binding}',1,1);`);
});
afterAll(async()=>{await db?.close();});
const payment=()=>db.exec("insert into payments(id,deal_id,amount_minor,currency,status) values(1,1,10000,'USD','ACTIVE')");
const notices=async()=>(await db.query('select * from buyer_portal_notices order by created_at,id')).rows;
const claim=async(w=worker)=>(await db.query('select buyer_portal_claim_notice($1) value',[w])).rows[0].value;
const context=async(id,w=worker)=>(await db.query('select buyer_portal_notice_context($1,$2) value',[id,w])).rows[0].value;
it('queues only confirmed own payments, normalizes ACTIVE/POSTED and deduplicates identical edits',async()=>{
 await db.exec("insert into payments(id,deal_id,amount_minor,currency,status) values(2,1,10000,'USD','PENDING'),(3,2,10000,'USD','ACTIVE')");
 expect(await notices()).toHaveLength(0);await payment();
 await db.exec("update payments set status='POSTED' where id=1;update payments set amount_minor=10000 where id=1;");
 expect(await notices()).toHaveLength(1);
});
it('rechecks current payment state, ownership, recipient and preference before delivery',async()=>{
 await payment();const n=await claim();expect((await context(n.id)).telegramId).toBe('101');expect(await context(n.id,randomUUID())).toBeNull();
 await db.exec("update payments set status='VOIDED' where id=1");expect(await context(n.id)).toBeNull();
 const next=await claim();expect((await context(next.id)).kind).toBe('PAYMENT_VOIDED');
 await db.exec('update deals set lead_id=2 where id=1');expect(await context(next.id)).toBeNull();
});
it('atomically claims each queued notice and never retries an interrupted or uncertain delivery',async()=>{
 await payment();const n=await claim();expect(await claim(randomUUID())).toBeNull();
 await db.exec("update buyer_portal_notices set claimed_at=now()-interval '6 minutes'");
 expect(await claim(randomUUID())).toBeNull();expect((await notices())[0].status).toBe('UNKNOWN');
 await db.query("select buyer_portal_finish_notice($1,$2,'SENT')",[n.id,worker]);expect((await notices())[0].status).toBe('UNKNOWN');
});
it('cancels queued messages when notifications are disabled and does not backfill while disabled',async()=>{
 await payment();const settings=(await db.query('select buyer_portal_notification_settings(101,false,\'ru\') value')).rows[0].value;
 expect(settings).toEqual({enabled:false,language:'ru'});expect((await notices())[0].status).toBe('CANCELLED');
 await db.exec("insert into payments(id,deal_id,amount_minor,currency,status) values(2,1,20000,'USD','ACTIVE')");expect(await notices()).toHaveLength(1);
 expect((await db.query('select buyer_portal_notification_settings(202,true,null) value')).rows[0].value).toBeNull();
});
it('notifies only published documents and cancels their notification after revocation',async()=>{
 const id=randomUUID();await db.query("insert into buyer_portal_documents values($1,1,1,'DRAFT',repeat('a',64),true,'CONTRACT','tj')",[id]);
 expect(await notices()).toHaveLength(0);await db.query("update buyer_portal_documents set status='PUBLISHED' where id=$1",[id]);
 const n=await claim();expect((await context(n.id)).kind).toBe('DOCUMENT');
 await db.query("update buyer_portal_documents set status='REVOKED' where id=$1",[id]);expect(await context(n.id)).toBeNull();
});
it('coalesces multi-row schedule changes per transaction and ignores paid-status recalculation',async()=>{
 await db.exec('begin');try{await db.exec("insert into deal_payment_schedules values(1,1,'2026-12-01',50000,0,'UPCOMING'),(2,1,'2027-01-01',50000,0,'UPCOMING');commit;");}catch(error){await db.exec('rollback');throw error;}
 expect(await notices()).toHaveLength(1);const n=await claim();expect((await context(n.id)).kind).toBe('SCHEDULE_CHANGED');
 await db.exec("update deal_payment_schedules set paid_amount_minor=100,status='PARTIAL'");expect(await notices()).toHaveLength(1);
 await db.exec("update deal_payment_schedules set amount_minor=amount_minor+100");expect(await context(n.id)).toBeNull();
});
it('creates one CRM task, stores every inquiry, retries idempotently and records a scoped answer',async()=>{
 const id=randomUUID();const send=async(tg,msg)=>(await db.query('select buyer_portal_contact($1,1,$2,$3) value',[tg,id,msg])).rows[0].value;
 expect((await send(202,'Foreign')).status).toBe('UNAVAILABLE');expect((await send(101,'Мой вопрос')).status).toBe('ACCEPTED');
 expect((await send(101,'Мой вопрос')).status).toBe('ACCEPTED');expect((await db.query('select * from tasks')).rows).toHaveLength(1);
 const task=(await db.query('select * from tasks')).rows[0];expect(task).toMatchObject({lead_id:1,deal_id:1,assigned_user_id:2,status:'OPEN',type:'BUYER_INQUIRY'});
 const limited=(await db.query('select buyer_portal_contact(101,1,$1,\'Еще вопрос\') value',[randomUUID()])).rows[0].value;expect(limited.status).toBe('RATE_LIMITED');
 await db.query("select buyer_portal_reply(1,$1,2,'Ответ менеджера')",[id]);
 const history=(await db.query('select buyer_portal_inquiry_history(101,1) value')).rows[0].value;
 expect(history[0]).toMatchObject({message:'Мой вопрос',status:'ANSWERED',reply:'Ответ менеджера'});
 expect((await db.query('select buyer_portal_inquiry_history(202,1) value')).rows[0].value).toEqual([]);
 expect((await db.query('select status from tasks')).rows[0].status).toBe('COMPLETED');
 expect((await notices())[0].kind).toBe('INQUIRY_REPLY');
});
it('reassigns open customer tasks and closes old-owner tasks without mixing clients',async()=>{
 await db.query('select buyer_portal_contact(101,1,$1,\'Question\')',[randomUUID()]);
 await db.exec('update deals set responsible_user_id=3 where id=1');expect((await db.query('select assigned_user_id from tasks')).rows[0].assigned_user_id).toBe(3);
 await db.exec('update deals set lead_id=2 where id=1');expect((await db.query('select status from tasks')).rows[0].status).toBe('CANCELLED');
});
it('keeps all portal tables/functions private while trusted posting triggers work for existing CRM DB roles',async()=>{
 for(const role of ['anon','authenticated']){
  expect((await db.query("select has_table_privilege($1,'buyer_portal_notices','SELECT') ok",[role])).rows[0].ok).toBe(false);
  expect((await db.query("select has_table_privilege($1,'buyer_portal_inquiries','INSERT') ok",[role])).rows[0].ok).toBe(false);
  for(const fn of ['buyer_portal_claim_notice(uuid)','buyer_portal_contact(bigint,integer,uuid,text)','buyer_portal_queue_notice(integer,text,text,text,text,date)'])expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') ok",[role,fn])).rows[0].ok).toBe(false);
 }
 await db.exec('grant insert on payments to anon;set role anon');try{await payment();}finally{await db.exec('reset role');}
 expect(await notices()).toHaveLength(1);
});

it('queues a schedule notice even when all schedule rows are removed',async()=>{
 await db.exec("insert into deal_payment_schedules values(1,1,'2026-12-01',100000,0,'UPCOMING');truncate buyer_portal_notices;delete from deal_payment_schedules where deal_id=1");
 const n=await claim();expect((await context(n.id)).kind).toBe('SCHEDULE_CHANGED');
});
it('keeps inbox read markers private and expires stale facts before sending',async()=>{
 await payment();const n=await claim();await db.query("select buyer_portal_finish_notice($1,$2,'SENT')",[n.id,worker]);
 await db.query('select buyer_portal_read_notice(202,$1)',[n.id]);expect((await notices())[0].read_at).toBeNull();
 expect((await db.query('select buyer_portal_notice_history(202) value')).rows[0].value).toEqual([]);
 await db.query('select buyer_portal_read_notice(101,$1)',[n.id]);expect((await notices())[0].read_at).not.toBeNull();
 await db.exec("insert into payments(id,deal_id,amount_minor,currency,status) values(2,1,20000,'USD','ACTIVE');update buyer_portal_notices set created_at=now()-interval '25 hours' where status='PENDING'");
 const stale=await claim();expect(await context(stale.id)).toBeNull();
});
