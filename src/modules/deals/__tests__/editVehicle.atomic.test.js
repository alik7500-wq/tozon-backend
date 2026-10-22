import {describe,it,expect,beforeAll,afterAll,beforeEach,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
let db;
const car={brand_model:'Test Camry',vin:'TESTVIN',mileage_km:'0'};
const call=(updates={vehicle_details:car},actor=1)=>db.query('select public.update_deal_vehicle_atomic(1,$1,$2::jsonb) as deal',[actor,JSON.stringify(updates)]);
const rows=table=>db.query(`select * from ${table} order by id`).then(r=>r.rows);
beforeAll(async()=>{
 db=new PGlite();await db.exec(`
 create role anon;create role authenticated;create role service_role;
 create table users(id bigint primary key,role text,is_active int);
 create table leads(id bigint primary key,full_name text,phone text,passport_series text,passport_number text,inn text,updated_at text);
 create table deals(id bigint primary key,lead_id bigint,deal_date text,contract_number text,responsible_user_id bigint,reservation_expires_at text,payment_type text,installment_months int,barter_description text,barter_amount_minor bigint,base_price_minor bigint,discount_minor bigint,final_price_minor bigint,deal_price_per_m2_minor bigint,down_payment_minor bigint,exchange_rate numeric,updated_at text,vehicle_details jsonb);
 create table payments(id bigint primary key,deal_id bigint,amount_minor bigint,status text,cash_desk_id text);
 create table deal_payment_schedules(id serial primary key,deal_id bigint,payment_number int,due_date text,amount_minor bigint,paid_amount_minor bigint,status text,created_at text,updated_at text);
 insert into users values(1,'ADMIN',1),(2,'MANAGER',1),(3,'ADMIN',0);
 insert into leads(id,full_name) values(1,'Test Buyer');`);
 await db.exec(readFileSync(new URL('../../../db/migrations/020_add_deal_audit_log_and_atomic_update.sql',import.meta.url),'utf8'));
 await db.exec(readFileSync(new URL('../../../db/migrations/20261022130347_edit_deal_vehicle_details.sql',import.meta.url),'utf8'));
},20000);
afterAll(async()=>{await db.close();});
beforeEach(async()=>{
 await db.exec(`truncate deals,payments,deal_payment_schedules,deal_audit_logs cascade;
 insert into deals(id,lead_id,payment_type,contract_number,final_price_minor,down_payment_minor,barter_amount_minor,updated_at) values(1,1,'PARTIAL_BARTER','0062',3398300,1405400,1405400,'original');
 insert into payments values(1,1,1405405,'ACTIVE','test-cash');
 insert into deal_payment_schedules(deal_id,payment_number,due_date,amount_minor,paid_amount_minor,status) values(1,1,'2026-11-22',1992900,0,'UPCOMING');`);
});
describe('audited vehicle edits on paid contracts',()=>{
 it('saves vehicle and metadata atomically, preserving every payment and schedule field',async()=>{
  const payments=await rows('payments'),schedules=await rows('deal_payment_schedules');
  const result=await call({vehicle_details:car,barter_description:'Test car'});
  expect(result.rows[0].deal.vehicle_details).toEqual(car);
  expect(result.rows[0].deal.final_price_minor).toBe(3398300);expect(result.rows[0].deal.down_payment_minor).toBe(1405400);expect(result.rows[0].deal.barter_amount_minor).toBe(1405400);
  expect(await rows('payments')).toEqual(payments);expect(await rows('deal_payment_schedules')).toEqual(schedules);
  expect((await rows('deal_audit_logs'))[0].changes_json.updates.vehicle_details).toEqual(car);
 });
 it('allows clearing vehicle metadata explicitly',async()=>{await call();await call({vehicle_details:null});expect((await rows('deals'))[0].vehicle_details).toBeNull();});
 it.each([2,3])('rejects non-admin or inactive actor %s',async actor=>{await expect(call(undefined,actor)).rejects.toThrow();expect((await rows('deals'))[0].vehicle_details).toBeNull();});
 it('preserves the existing paid financial lock',async()=>{await expect(call({vehicle_details:car,final_price_minor:1})).rejects.toThrow('PAID_DEAL_FINANCIAL_EDIT_BLOCKED');expect((await rows('deals'))[0].vehicle_details).toBeNull();});
 it('rolls back vehicle, deal and buyer edits if audit fails',async()=>{
  const before=await rows('deals');await db.exec("alter table deal_audit_logs add constraint reject_audit check(action<>'UPDATE_DEAL')");
  try{await expect(call()).rejects.toThrow();expect(await rows('deals')).toEqual(before);}finally{await db.exec('alter table deal_audit_logs drop constraint reject_audit');}
 });
 it.each([{vehicle_details:[]},{vehicle_details:{engine_number:'NO'}},{vehicle_details:{color:123}}])('rejects unsupported payload %j',async data=>{await expect(call(data)).rejects.toThrow();});
 it('cannot be called by public API roles',async()=>{for(const role of ['anon','authenticated']){expect((await db.query("select has_function_privilege($1,'public.update_deal_vehicle_atomic(bigint,bigint,jsonb,jsonb,jsonb)','EXECUTE') as allowed",[role])).rows[0].allowed).toBe(false);}});
});
