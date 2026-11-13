import {beforeAll,afterAll,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {projectBuyerContract} from './financial-projection.js';
let db;
beforeAll(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table users(id integer primary key,name text,email text);
 create table leads(id integer primary key,phone text,passport_number text);
 create table projects(id integer primary key,name text);
 create table buildings(id integer primary key,project_id integer,name text);
 create table sections(id integer primary key,building_id integer,name text);
 create table floors(id integer primary key,section_id integer,floor_number integer);
 create table units(id integer primary key,floor_id integer,unit_number text,unit_kind text,area_m2_x100 integer,rooms integer);
 create table expenses(id integer primary key,amount_minor integer,currency text,expense_date date,status text,reference text,amount_usd numeric,amount_tjs numeric,exchange_rate numeric);
 create table deals(id integer primary key,lead_id integer,status text,unit_id integer,responsible_user_id integer,contract_number text,deal_date date,currency text,final_price_minor integer,down_payment_minor integer,barter_amount_minor integer,payment_type text,first_payment_date date,refund_expense_id integer);
 create table payments(id integer primary key,deal_id integer,amount_minor integer,currency text,amount_usd numeric,amount_tjs numeric,exchange_rate numeric,payment_date date,status text,operation_type text,settlement_method text,method text,reference text,document_number text,customer_pko_number bigint,comment text,transfer_id uuid,conversion_id uuid);
 create table deal_payment_schedules(id integer primary key,deal_id integer,payment_number integer,due_date date,amount_minor integer,paid_amount_minor integer,status text);
 insert into users values(1,'Менеджер','SECRET_EMAIL');insert into leads values(1,'+992900000001','SECRET_PASSPORT'),(2,'+992900000002','SECRET_OTHER');
 insert into projects values(1,'TOZON');insert into buildings values(1,1,'Б');insert into sections values(1,1,'1');insert into floors values(1,1,3);insert into units values(1,1,'7','APARTMENT',8180,2);
 insert into deals values(1,1,'SIGNED',1,1,'001','2026-10-01','USD',100000,0,0,'INSTALLMENT','2026-11-01',null),(2,2,'SIGNED',1,1,'002','2026-10-01','USD',200000,0,0,'INSTALLMENT',null,null);
 insert into payments(id,deal_id,amount_minor,currency,payment_date,status,operation_type,settlement_method,comment) values(1,1,10000,'USD','2026-11-01','ACTIVE','STANDARD','CASH','SECRET_NOTE [Назначение: Взнос]'),(2,2,999999,'USD','2026-11-01','ACTIVE','STANDARD','CASH','SECRET_OTHER');
 insert into deal_payment_schedules values(1,1,1,'2026-11-01',100000,0,'UPCOMING');
 grant select,update on all tables in schema public to service_role;`);
 for(const file of ['20261113195039_buyer_portal_identity.sql','20261113200522_buyer_portal_entry.sql','20261113215028_buyer_portal_financial_read.sql'])await db.exec(readFileSync(new URL('../../../supabase/migrations/'+file,import.meta.url),'utf8'));
 await db.exec(`insert into buyer_portal_bindings(id,lead_id,telegram_id,phone_snapshot) values('11111111-1111-4111-8111-111111111111',1,101,'+992900000001');
 insert into buyer_portal_grants(binding_id,deal_id,owner_lead_id) values('11111111-1111-4111-8111-111111111111',1,1);`);
},20000);
afterAll(async()=>{await db?.close();});
const snapshot=async(tg,id)=>(await db.query('select buyer_portal_contract_snapshot($1,$2) value',[tg,id])).rows[0].value;
it('executes authorized snapshot and list with actual service-role privileges, without PII',async()=>{
 await db.exec('set role service_role');
 try{
  const raw=await snapshot(101,1);expect(JSON.stringify(raw)).not.toContain('SECRET');
  const result=projectBuyerContract(raw,'2026-11-14');expect(result.summary.paidMinor).toBe(10000);expect(result.history[0].purpose).toBe('Взнос');
  const list=(await db.query('select buyer_portal_contracts(101) value')).rows[0].value;
  expect(list.map(d=>d.id)).toEqual([1]);expect(await snapshot(101,2)).toBeNull();expect(await snapshot(202,1)).toBeNull();expect(await snapshot(101,999)).toBeNull();
 }finally{await db.exec('reset role');}
});
it('keeps both financial functions inaccessible to anon/authenticated',async()=>{
 for(const role of ['anon','authenticated'])for(const fn of ['buyer_portal_contracts(bigint)','buyer_portal_contract_snapshot(bigint,integer)']){
  expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') ok",[role,fn])).rows[0].ok).toBe(false);
 }
});
it('reflects a moved payment only in its current contract, without historical duplicates',async()=>{
 await db.exec('update payments set deal_id=2 where id=1');
 expect((await snapshot(101,1)).payments).toEqual([]);expect(await snapshot(101,2)).toBeNull();
 await db.exec('update payments set deal_id=1 where id=1');
});
it('stops returning contract data immediately after ownership changes, permanently',async()=>{
 await db.exec('update deals set lead_id=2 where id=1');
 expect(await snapshot(101,1)).toBeNull();
 await db.exec('update deals set lead_id=1 where id=1');expect(await snapshot(101,1)).toBeNull();
});
