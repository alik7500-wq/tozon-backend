import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { validateAmendment } from '../amendment.validation.js';

let db;
const stamp = '2026-10-01T00:00:00Z';
const amendment = (overrides = {}) => ({unit_id:2,final_price_minor:5000000,deal_price_per_m2_minor:50000,reason:'Customer agreed replacement',expected_updated_at:stamp,...overrides});
const call = (data = amendment(), actor = 1) => db.query('select amend_deal_atomic(1,$1,$2::jsonb) as deal',[actor,JSON.stringify(data)]);
const rows = table => db.query(`select * from ${table} order by id`).then(r => r.rows);

beforeAll(async () => {
 db = new PGlite();
 await db.exec(`
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 CREATE TABLE users(id int primary key,role text,is_active int);
 CREATE TABLE projects(id int primary key,currency text);
 CREATE TABLE buildings(id int primary key,project_id int);
 CREATE TABLE sections(id int primary key,building_id int);
 CREATE TABLE floors(id int primary key,section_id int);
 CREATE TABLE units(id int primary key,floor_id int,unit_number text,area_m2_x100 int,status text,archived_at text,updated_at text);
 CREATE TABLE deals(id int primary key,unit_id int references units(id),contract_number text,deal_date text,status text,payment_type text,currency text,
 base_price_minor int,discount_minor int,final_price_minor int,deal_price_per_m2_minor bigint,down_payment_minor int,updated_at text);
 CREATE UNIQUE INDEX active_unit ON deals(unit_id) WHERE status IN ('RESERVED','SIGNED');
 CREATE TABLE deal_payment_schedules(id int primary key,deal_id int references deals(id),payment_number int,due_date text,amount_minor int check(amount_minor>0),paid_amount_minor int,status text,updated_at text);
 CREATE TABLE payments(id int primary key,deal_id int references deals(id),schedule_id int references deal_payment_schedules(id),amount_minor int,status text,exchange_rate numeric,amount_tjs numeric,cash_desk_id text);
 CREATE TABLE deal_audit_logs(id serial primary key,deal_id int,user_id int,action text,changes_json jsonb);
 INSERT INTO users VALUES(1,'ADMIN',1),(2,'MANAGER',1),(3,'ADMIN',0);
 INSERT INTO projects VALUES(1,'USD'),(2,'USD');
 INSERT INTO buildings VALUES(1,1),(2,2); INSERT INTO sections VALUES(1,1),(2,2); INSERT INTO floors VALUES(1,1),(2,2);
 `);
 await db.exec(readFileSync(new URL('../../../db/migrations/20261008181434_contract_amendment.sql',import.meta.url),'utf8'));
});
afterAll(async()=>{await db.close();});
beforeEach(async()=>{
 await db.exec(`TRUNCATE payments,deal_payment_schedules,deal_audit_logs,deals,units CASCADE;
 INSERT INTO units VALUES(1,1,'A1',9220,'SOLD',null,'${stamp}'),(2,1,'A2',10000,'AVAILABLE',null,'${stamp}'),(3,2,'B1',8000,'AVAILABLE',null,'${stamp}');
 INSERT INTO deals VALUES(1,1,'0006','2026-02-12','SIGNED','INSTALLMENT','USD',4425600,0,4425600,48000,664100,'${stamp}');
 INSERT INTO deal_payment_schedules VALUES(10,1,1,'2026-03-12',1880750,771432,'PARTIAL','${stamp}'),(11,1,2,'2026-12-12',1880750,0,'UPCOMING','${stamp}');
 INSERT INTO payments VALUES(100,1,10,1435532,'ACTIVE',9.29,133361.92,'test-desk'),(101,1,11,100000,'VOIDED',9.26,9260,'test-desk');`);
});

describe('atomic contract amendment (real PostgreSQL engine, synthetic data)',()=>{
 it('keeps identity and all payment/PKO data; updates both units and exact FIFO plan',async()=>{
   const before=await rows('payments'); await call();
   const [d]=await rows('deals'); expect(d.unit_id).toBe(2); expect(d.contract_number).toBe('0006'); expect(d.deal_date).toBe('2026-02-12');
   expect(await rows('payments')).toEqual(before);
   expect((await rows('units')).map(u=>u.status)).toEqual(['AVAILABLE','SOLD','AVAILABLE']);
   const s=await rows('deal_payment_schedules'); expect(s.map(x=>x.id)).toEqual([10,11]); expect(s.map(x=>x.due_date)).toEqual(['2026-03-12','2026-12-12']);
   expect(s.reduce((n,x)=>n+x.amount_minor,0)).toBe(5000000-664100);
   expect(s.reduce((n,x)=>n+x.paid_amount_minor,0)).toBe(1435532-664100);
   const [audit]=await rows('deal_audit_logs'); expect(audit.action).toBe('AMEND_CONTRACT'); expect(audit.changes_json.paid_minor).toBe(1435532);
 });
 it('supports cheaper apartment with overpayment without issuing or editing payments',async()=>{
   const before=await rows('payments'); await call(amendment({final_price_minor:1000000}));
   expect(await rows('payments')).toEqual(before);
   expect((await rows('deal_audit_logs'))[0].changes_json.overpayment_minor).toBe(435532);
   expect((await rows('deal_payment_schedules')).every(x=>x.status==='PAID')).toBe(true);
 });
 it('supports price-only correction and preserves unit status',async()=>{
   await call(amendment({unit_id:1})); expect((await rows('units'))[0].status).toBe('SOLD');
 });
 it('keeps RESERVED replacement reserved',async()=>{
   await db.exec("update deals set status='RESERVED'; update units set status='RESERVED' where id=1");
   await call(); expect((await rows('units'))[1].status).toBe('RESERVED');
 });
 it.each(['RESERVED','SOLD','BLOCKED'])('rejects unavailable target %s with no writes',async(status)=>{
   await db.query('update units set status=$1 where id=2',[status]); const before=await rows('deals');
   await expect(call()).rejects.toThrow('UNIT_UNAVAILABLE'); expect(await rows('deals')).toEqual(before); expect(await rows('deal_audit_logs')).toEqual([]);
 });
 it('rejects archived targets',async()=>{await db.exec("update units set archived_at='2026-10-01' where id=2");await expect(call()).rejects.toThrow('UNIT_UNAVAILABLE');});
 it('rejects stale and repeated submissions',async()=>{await call();await expect(call()).rejects.toThrow('STALE_DEAL');expect(await rows('deal_audit_logs')).toHaveLength(1);});
 it('rejects cross-project replacement',async()=>{await expect(call(amendment({unit_id:3}))).rejects.toThrow('AMENDMENT_INVALID');});
 it.each([2,3])('rejects unauthorized/inactive actor %s',async(actor)=>{await expect(call(amendment(),actor)).rejects.toThrow('AMENDMENT_INVALID');});
 it('rejects cancelled contracts',async()=>{await db.exec("update deals set status='CANCELLED'");await expect(call()).rejects.toThrow('AMENDMENT_INVALID');});
 it('rejects contract identity and payment fields at both boundaries',async()=>{
   expect(()=>validateAmendment(amendment({contract_number:'new'}))).toThrow();
   await expect(call(amendment({contract_number:'new'}))).rejects.toThrow('AMENDMENT_INVALID');
 });
 it('rolls back deal, units and schedules if audit insert fails',async()=>{
   const before=await rows('deals'); const units=await rows('units'); const schedules=await rows('deal_payment_schedules');
   await db.exec("alter table deal_audit_logs add constraint fail_audit check(action<>'AMEND_CONTRACT')");
   try {await expect(call()).rejects.toThrow(); expect(await rows('deals')).toEqual(before);expect(await rows('units')).toEqual(units);expect(await rows('deal_payment_schedules')).toEqual(schedules);}
   finally {await db.exec('alter table deal_audit_logs drop constraint fail_audit');}
 });
 it('blocks anon and authenticated execution',async()=>{
   for (const role of ['anon','authenticated']) {
     const result=await db.query("select has_function_privilege($1,'amend_deal_atomic(bigint,bigint,jsonb)','EXECUTE') as allowed",[role]);
     expect(result.rows[0].allowed).toBe(false);
   }
 });
 it.each([NaN,Infinity,-1,0,1.5,'5000',2147483648])('validates invalid prices %s',value=>{expect(()=>validateAmendment(amendment({final_price_minor:value}))).toThrow();});
});
