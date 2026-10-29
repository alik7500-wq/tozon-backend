import {it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {buildCostReport} from '../costs/costs.service.js';
it('atomically posts bot RKO, allocates costs, audits and prevents duplicate or partial accounting',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table users(id integer primary key,is_active integer);insert into users values(1,1);
 create table dictionaries(id uuid primary key,type text,is_active boolean,code text,name text);insert into dictionaries values('11111111-1111-4111-8111-111111111111','CASH_DESK',true,'MAIN','Test');
 create table telegram_finance_subscribers(telegram_id text primary key,slot text,status text);insert into telegram_finance_subscribers values('7','AKMALKHON','APPROVED');
 create table projects(id integer primary key,name text,archived_at timestamptz);insert into projects values(1,'Test',null),(2,'Other',null);
 create table buildings(id integer primary key,project_id integer,name text,archived_at timestamptz);insert into buildings values(3,1,'A',null),(4,1,'B',null),(5,2,'Other',null);
 create table cost_building_bases(building_id integer primary key,sellable_area_m2 numeric,version integer);insert into cost_building_bases values(3,200,1),(4,100,1);
 create table expenses(id serial primary key,amount_minor integer,currency text,expense_date date,category text,status text,operation_type text);
 create table cost_expense_allocations(expense_id integer primary key references expenses(id),mode text,shares jsonb,reason text,updated_by integer);
 create table cost_audit(id serial primary key,entity text,entity_id integer,before_data jsonb,after_data jsonb,actor_id integer);
 create function create_atomic_expense(p_cash_desk_id uuid,p_amount_minor bigint,p_currency varchar,p_expense_date date,p_category varchar,p_recipient varchar,p_description text,p_user_id integer,p_method varchar,p_exchange_rate numeric,p_amount_usd numeric,p_amount_tjs numeric,p_idempotency_key varchar) returns jsonb language plpgsql as $$declare i integer;begin
 insert into public.expenses(amount_minor,currency,expense_date,category,status,operation_type) values(p_amount_minor,p_currency,p_expense_date,p_category,'ACTIVE','STANDARD') returning id into i;
 return jsonb_build_object('success',true,'expense_id',i,'currency',p_currency,'amount',p_amount_minor/100.0);end;$$;`);
 for(const name of ['20261012094220_telegram_cash_operations.sql','20261012120000_telegram_sheet_outbox.sql','20261030001000_telegram_rko_cost_allocation.sql'])await db.exec(readFileSync(new URL('../../../supabase/migrations/'+name,import.meta.url),'utf8'));
 await db.exec("update telegram_finance_subscribers set crm_user_id=1,can_create_expense=true");
 const payload={date:'2026-10-29',amount_minor:92700,currency:'TJS',source_currency:'USD',exchange_rate:9.27,category:'Питание',recipient:'Synthetic',description:'Synthetic',cost:{mode:'DIRECT',buildings:[3]}};
 const make=async(p)=>(await db.query(`insert into telegram_finance_expense_drafts(telegram_id,cash_desk_id,payload) values('7','11111111-1111-4111-8111-111111111111',$1) returning id`,[JSON.stringify(p)])).rows[0].id;
 const post=async(id)=>(await db.query("select telegram_finance_post_expense('7',$1) r",[id])).rows[0].r;
 const first=await make(payload);expect((await post(first)).cost_mode).toBe('DIRECT');await post(first);
 expect((await db.query('select count(*)::int n from expenses')).rows[0].n).toBe(1);
 expect((await db.query('select count(*)::int n from cost_audit')).rows[0].n).toBe(1);
 const report=buildCostReport({buildings:[{id:3},{id:4}],bases:[{building_id:3,sellable_area_m2:200}],registry:{},expenses:(await db.query('select * from expenses')).rows,allocations:(await db.query('select * from cost_expense_allocations')).rows,advances:[],asOf:'2026-10-30'});
 expect(report.blocks[0].amount_usd_minor).toBe(10000);expect(report.blocks[0].cost_per_m2_usd).toBe(0.5);
 await post(await make({...payload,cost:{mode:'SHARED',buildings:[3,4]}}));
 expect((await db.query("select shares from cost_expense_allocations where mode='SHARED'")).rows[0].shares.map(s=>s.weight)).toEqual([200,100]);
 for(const cost of [undefined,{mode:'DIRECT',buildings:[99]},{mode:'SHARED',buildings:[3,5]},{mode:'SHARED',buildings:[3,3]}]){
  const id=await make({...payload,cost});await expect(post(id)).rejects.toThrow();
  expect((await db.query('select status from telegram_finance_expense_drafts where id=$1',[id])).rows[0].status).toBe('DRAFT');
 }
 await db.exec('delete from cost_building_bases where building_id=4');
 await expect(post(await make({...payload,cost:{mode:'SHARED',buildings:[3,4]}}))).rejects.toThrow('COST_AREA_MISSING');
 await expect(post(await make({...payload,category:'Арматура'}))).rejects.toThrow('COST_MATERIAL_USAGE_REQUIRED');
 expect((await post(await make({...payload,category:'Бетон',cost:{mode:'MATERIAL',buildings:[]}}))).cost_mode).toBe('UNASSIGNED');
 await db.exec("create function fail_cost_audit() returns trigger language plpgsql as $$begin raise exception 'SIMULATED_COST_FAILURE';end;$$;create trigger fail_audit before insert on cost_audit for each row execute function fail_cost_audit();");
 await expect(post(await make(payload))).rejects.toThrow('SIMULATED_COST_FAILURE');
 expect((await db.query('select count(*)::int n from expenses')).rows[0].n).toBe(3);
 expect((await db.query('select count(*)::int n from telegram_finance_sheet_outbox')).rows[0].n).toBe(3);
 expect((await db.query("select has_function_privilege('anon','telegram_finance_post_expense(text,uuid)','execute') allowed")).rows[0].allowed).toBe(false);
 }finally{await db.close();}
});
