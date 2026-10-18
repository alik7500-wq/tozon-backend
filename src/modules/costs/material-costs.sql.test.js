import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
let db;
const U1='00000000-0000-4000-8000-000000000001', U2='00000000-0000-4000-8000-000000000002', P1='00000000-0000-4000-8000-000000000011', P2='00000000-0000-4000-8000-000000000012';
const q=async(sql,args=[]) => (await db.query(sql,args)).rows;
const usage = (id=U1,patch={},version=0,actor=1) => q('select cost_save_material_usage($1,$2,$3,$4) data',[id,JSON.stringify({ building_id:3,material_kind:'REBAR',usage_date:'2026-10-01',quantity:20,unit:'т',amount:100000,currency:'TJS',exchange_rate:10,reason:'Confirmed invoice',...patch }),version,actor]);
const payment = (id=P1,usageId=U1,paid=40000,cash=400000,version=0) => q("select cost_save_material_payment($1,$2,1,$3,$4,'Supplier settlement',$5,1) data",[id,usageId,paid,cash,version]);
beforeAll(async()=>{
 db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create table users(id integer primary key,role text,is_active integer,permissions jsonb);
 create table buildings(id integer primary key,project_id integer,archived_at text);
 create table expenses(id integer primary key,amount_minor integer,currency text,expense_date date,category text,operation_type text,transfer_id uuid,conversion_id uuid,conversion_expense_id integer,status text,voided_at timestamptz,exchange_rate numeric,amount_usd numeric);
 create table construction_documents(id uuid primary key,number integer,expense_id integer,kind text,status text,project_id integer,doc_date date,currency text,exchange_rate numeric);
 create table construction_materials(id uuid primary key,unit text);
 create table construction_stock_entries(id bigint primary key,document_id uuid,material_id uuid,quantity numeric,value numeric,currency text);
 insert into users values(1,'ADMIN',1,'[]'),(2,'MANAGER',1,'[]'); insert into buildings values(3,3,null),(4,3,null);`);
 for(const name of ['20261018084531_block_cost_accounting.sql','20261018100726_material_cost_tables.sql','20261018100730_material_cost_functions.sql']) await db.exec(readFileSync(new URL('../../../supabase/migrations/'+name,import.meta.url),'utf8'));
},20000);
beforeEach(async()=>{
 await db.exec(`truncate cost_material_payment_links,cost_material_usages,cost_material_audit,cost_expense_allocations,expenses,construction_documents,construction_stock_entries,construction_materials;
 insert into expenses(id,amount_minor,currency,expense_date,category,status,operation_type) values(1,400000,'USD','2026-10-02','Materials','ACTIVE','STANDARD');`);
});
afterAll(async()=>db?.close());
describe('Material usage and payment PostgreSQL integrity',()=>{
 it('saves a usage and payment without changing cash or construction data',async()=>{
  const before=await q('select * from expenses'); await usage(); await payment();
  expect(await q('select * from expenses')).toEqual(before);expect(await q('select * from construction_stock_entries')).toEqual([]);
  expect((await q('select count(*)::int n from cost_material_audit'))[0].n).toBe(2);
 });
 it('copies quantity/value/date/FX from immutable posted source instead of submitted values',async()=>{
  await db.exec(`insert into construction_documents values('${U2}',4,null,'WRITE_OFF','POSTED',3,'2026-10-01','TJS',9.26);
   insert into construction_materials values('${U2}','м³'); insert into construction_stock_entries values(4,'${U2}','${U2}',-84.5,-27885,'TJS');`);
  const r=await usage(U1,{stock_entry_id:4,quantity:1,amount:1,material_kind:'CONCRETE'});
  expect(Number(r[0].data.amount)).toBe(27885);expect(Number(r[0].data.quantity)).toBe(84.5);expect(Number(r[0].data.exchange_rate)).toBe(9.26);
  await expect(usage(U2,{stock_entry_id:4})).rejects.toThrow();
 });
 it('requires historical FX for manual TJS usage',async()=>{await expect(usage(U1,{exchange_rate:null})).rejects.toThrow('исторический курс');});
 it('refuses payment above either native debt or RKO amount',async()=>{
  await usage();await expect(payment(P1,U1,100001,400000)).rejects.toThrow('стоимость');await expect(payment(P1,U1,40000,400001)).rejects.toThrow('РКО');
 });
 it('prevents over-allocation of one RKO over multiple usages',async()=>{
  await usage();await usage(U2);await payment(P1,U1,30000,300000);await expect(payment(P2,U2,20000,200000)).rejects.toThrow('РКО');
 });
 it('refuses transfer, voided and conversion RKO',async()=>{
  await usage();
  for(const status of ["status='VOIDED'","operation_type='CONVERSION'","category='Конвертация валюты'"]){await db.exec('update expenses set '+status);await expect(payment()).rejects.toThrow('действующий РКО');await db.exec("update expenses set status='ACTIVE',operation_type='STANDARD',category='Materials'");}
 });
 it('blocks material edits while payments are attached and audits unlinking',async()=>{
  await usage();await payment();await expect(usage(U1,{amount:90000},1)).rejects.toThrow('отмените привязки');
  await q("select cost_remove_material_payment($1,1,'Correction of reference',1)",[P1]);await usage(U1,{amount:90000},1);
  expect((await q("select * from cost_material_payment_links where status='ACTIVE'")).length).toBe(0);
  expect((await q("select * from cost_material_audit where entity='PAYMENT' and after_data->>'removed'='true'")).length).toBe(1);
 });
 it('refuses stale updates and unauthorized actors',async()=>{
  await usage();await expect(usage()).rejects.toThrow('VERSION_CONFLICT');await expect(usage(U2,{},0,2)).rejects.toThrow('COST_ACCESS_DENIED');
 });
 it('accepts a full native debt settlement even when cash USD differs due to FX',async()=>{
  await usage();await payment(P1,U1,100000,400000);expect(Number((await q('select paid_amount from cost_material_payment_links'))[0].paid_amount)).toBe(100000);
 });
 it('protects a linked RKO from deletion instead of silently reopening paid debt',async()=>{
  await usage();await payment();await expect(db.exec('delete from expenses where id=1')).rejects.toThrow();
 });
 it('keeps tables and functions private',async()=>{
  expect((await q("select has_table_privilege('anon','cost_material_usages','SELECT') a,has_function_privilege('authenticated','cost_save_material_usage(uuid,jsonb,integer,integer)','EXECUTE') b"))[0]).toEqual({a:false,b:false});
 });
});
