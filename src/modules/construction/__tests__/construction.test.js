import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const migration=readFileSync(new URL('../../../../supabase/migrations/20261012102239_construction_accounting.sql',import.meta.url),'utf8');
let db,employee,supplier,warehouse,destination,material;
const seed=`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE TABLE users(id integer PRIMARY KEY,name text,role text,permissions jsonb DEFAULT '[]',is_active boolean DEFAULT true);
CREATE TABLE projects(id integer PRIMARY KEY,name text);
CREATE TABLE expenses(id integer PRIMARY KEY,amount_minor bigint,currency text,expense_date date,status text DEFAULT 'ACTIVE',operation_type text DEFAULT 'STANDARD',transfer_id uuid,conversion_id uuid,voided_at timestamptz);
CREATE TABLE payments(id integer PRIMARY KEY,amount_minor bigint,currency text,payment_date date,status text DEFAULT 'ACTIVE',operation_type text DEFAULT 'STANDARD',transfer_id uuid,conversion_id uuid,voided_at timestamptz);
INSERT INTO users VALUES(1,'Owner','ADMIN','[]',true),(2,'Storekeeper','MANAGER','["construction.stock","construction.advance"]',true),(3,'Other','MANAGER','[]',true);
INSERT INTO projects VALUES(1,'TOZON PLAZA');`;
const query=async(q,p=[])=> (await db.query(q,p)).rows;
const document=async(fields={})=>{
 const data={kind:'RECEIPT',doc_date:'2026-10-02',currency:'TJS',warehouse_id:warehouse,party_id:supplier,basis:'Test',created_by:1,lines:[{material_id:material,quantity:100,value:1000}],...fields};
 const keys=Object.keys(data);return (await query(`INSERT INTO construction_documents(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING id`,keys.map(k=>k==='lines'?JSON.stringify(data[k]):data[k])))[0].id;
};
const post=async(id,actor=1)=>query('SELECT construction_post($1,$2)',[id,actor]);
const sum=async(table,col,where='true')=>Number((await query(`SELECT coalesce(sum(${col}),0) amount FROM ${table} WHERE ${where}`))[0].amount);
beforeEach(async()=>{
 db=new PGlite();await db.exec(seed);await db.exec(migration);await db.exec(readFileSync(new URL('../../../../supabase/migrations/20261012103959_construction_cash_link_validation.sql',import.meta.url),'utf8'));
 employee=(await query("UPDATE construction_parties SET user_id=2 WHERE kind='EMPLOYEE' RETURNING id"))[0].id;
 supplier=(await query("INSERT INTO construction_parties(name,kind) VALUES('Supplier','SUPPLIER') RETURNING id"))[0].id;
 warehouse=(await query("INSERT INTO construction_warehouses(name,responsible_id) VALUES('Main',$1) RETURNING id",[employee]))[0].id;
 destination=(await query("INSERT INTO construction_warehouses(name) VALUES('Second') RETURNING id"))[0].id;
 material=(await query("INSERT INTO construction_materials(name,unit) VALUES('Cement','kg') RETURNING id"))[0].id;
 await db.exec('UPDATE construction_settings SET approver_user_id=1');
 await db.exec('CREATE TABLE buildings(id integer PRIMARY KEY); INSERT INTO buildings VALUES(1)');
 await db.exec(readFileSync(new URL('../../../../supabase/migrations/20261018100726_material_cost_tables.sql',import.meta.url),'utf8'));
 await db.exec(readFileSync(new URL('../../../../supabase/migrations/20261018184855_receipt_price_corrections.sql',import.meta.url),'utf8'));
});
afterEach(async()=>{await db.close();});
describe('Construction accounting transactional ledger',()=>{
 it('receives stock and supplier payable once, without cash movement',async()=>{
  const id=await document();await post(id);await post(id);
  expect(await sum('construction_stock_entries','quantity')).toBe(100);
  expect(await sum('construction_settlement_entries','amount')).toBe(1000);
  expect((await query('SELECT * FROM expenses')).length).toBe(0);
 });
 it('issues at average cost and atomically refuses overspend across multiple lines',async()=>{
  await post(await document());
  await post(await document({kind:'ISSUE',project_id:1,work_type:'Concrete',lines:[{material_id:material,quantity:30}]}));
  expect(await sum('construction_stock_entries','quantity')).toBe(70);
  expect(await sum('construction_stock_entries','value')).toBe(700);
  const id=await document({kind:'ISSUE',project_id:1,work_type:'Concrete',lines:[{material_id:material,quantity:10},{material_id:material,quantity:80}]});
  await expect(post(id)).rejects.toThrow('Недостаточно');
  expect(await sum('construction_stock_entries','quantity')).toBe(70);
  expect((await query('SELECT status FROM construction_documents WHERE id=$1',[id]))[0].status).toBe('DRAFT');
 });
 it('moves stock without expense or change of total value',async()=>{
  await post(await document());await post(await document({kind:'TRANSFER',destination_id:destination,lines:[{material_id:material,quantity:40}]}));
  expect(await sum('construction_stock_entries','quantity')).toBe(100);
  expect(await sum('construction_stock_entries','value')).toBe(1000);
  expect(await sum('construction_stock_entries','quantity',`warehouse_id='${destination}'`)).toBe(40);
 });
 it('separates currencies and rejects stock movements before existing movement',async()=>{
  await post(await document());
  await expect(post(await document({kind:'ISSUE',currency:'USD',project_id:1,work_type:'Concrete',lines:[{material_id:material,quantity:1}]}))).rejects.toThrow('Недостаточно');
  await expect(post(await document({kind:'OPENING_STOCK',doc_date:'2026-10-01'}))).rejects.toThrow('задним числом');
 });
 it('links cash payment without duplicate cash expense and protects cash source',async()=>{
  await post(await document());
  await db.exec("INSERT INTO expenses(id,amount_minor,currency,expense_date) VALUES(1,60000,'TJS','2026-10-03')");
  const id=await document({kind:'SETTLEMENT_PAYMENT',doc_date:'2026-10-03',balance_type:'PAYABLE',amount:600,expense_id:1,lines:[]});
  await post(id);
  expect(await sum('construction_settlement_entries','amount')).toBe(400);
  expect((await query('SELECT * FROM expenses')).length).toBe(1);
  await expect(db.exec("UPDATE expenses SET amount_minor=70000 WHERE id=1")).rejects.toThrow('связан');
  await expect(db.exec('DELETE FROM expenses WHERE id=1')).rejects.toThrow('связан');
 });
 it('rejects incorrect currency, amount, date and conversion cash links',async()=>{
  await db.exec("INSERT INTO expenses(id,amount_minor,currency,expense_date) VALUES(1,60000,'TJS','2026-10-03')");
  for(const overrides of [{currency:'USD'},{amount:500},{doc_date:'2026-10-04'}]){
   const id=await document({kind:'ADVANCE_ISSUE',doc_date:'2026-10-03',party_id:employee,amount:600,expense_id:1,lines:[],...overrides});
   await expect(post(id)).rejects.toThrow();await db.query('DELETE FROM construction_documents WHERE id=$1',[id]);
  }
  await db.exec("UPDATE expenses SET operation_type='INTERNAL_CASH_TRANSFER' WHERE id=1");
  await expect(post(await document({kind:'ADVANCE_ISSUE',doc_date:'2026-10-03',party_id:employee,amount:600,expense_id:1,lines:[]}))).rejects.toThrow('без перемещения');
 });
 it('requires owner approval; material receipt is counted only once',async()=>{
  await post(await document({kind:'OPENING_ADVANCE',doc_date:'2026-10-01',party_id:employee,amount:1500,lines:[]}));
  const receipt=await document({party_id:employee});await post(receipt);
  expect(await sum('construction_settlement_entries','amount')).toBe(1500);
  const report=await document({kind:'ADVANCE_REPORT',party_id:employee,doc_date:'2026-10-03',status:'SUBMITTED',lines:[{amount:1000,basis:'Materials',proof:'Invoice 1',receipt_id:receipt},{amount:200,basis:'Delivery',proof:'Receipt 2'}]});
  await expect(post(report,2)).rejects.toThrow('назначенный руководитель');await post(report);
  expect(await sum('construction_stock_entries','quantity')).toBe(100);
  expect(await sum('construction_settlement_entries','amount')).toBe(300);
  const duplicate=await document({kind:'ADVANCE_REPORT',party_id:employee,status:'SUBMITTED',lines:[{amount:1000,basis:'Materials',proof:'Invoice 1',receipt_id:receipt}]});
  await expect(post(duplicate)).rejects.toThrow();
 });
 it('rejects unauthorized posting and missing approval setup',async()=>{
  await expect(post(await document(),3)).rejects.toThrow('прав');
  await db.exec('UPDATE construction_settings SET approver_user_id=NULL');
  await expect(post(await document({kind:'ADVANCE_REPORT',party_id:employee,status:'SUBMITTED',lines:[{amount:10,basis:'Delivery',proof:'Receipt'}]}))).rejects.toThrow('руководитель');
 });
 it('rejects cash links in stock documents so a storekeeper cannot freeze unrelated cash entries',async()=>{
  await db.exec("INSERT INTO expenses(id,amount_minor,currency,expense_date) VALUES(1,100000,'TJS','2026-10-02')");
  await expect(post(await document({expense_id:1}),2)).rejects.toThrow('только с денежной');
  expect(await sum('construction_stock_entries','quantity')).toBe(0);
 });
 it('supports existing integer active flag and protects posted document',async()=>{
  await db.exec('ALTER TABLE users ALTER COLUMN is_active DROP DEFAULT; ALTER TABLE users ALTER COLUMN is_active TYPE integer USING CASE WHEN is_active THEN 1 ELSE 0 END');
  const id=await document();await post(id);await expect(db.query("UPDATE construction_documents SET amount=10 WHERE id=$1",[id])).rejects.toThrow('неизменяем');
 });
 it('locks down tables and functions for anon/authenticated',async()=>{
  for(const role of ['anon','authenticated']){
   const rows=await query("SELECT tablename,rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'construction_%'");
   expect(rows.every(r=>r.rowsecurity)).toBe(true);
   for(const r of rows){for(const op of ['SELECT','INSERT','UPDATE','DELETE'])expect((await query('SELECT has_table_privilege($1,$2,$3) allowed',[role,r.tablename,op]))[0].allowed).toBe(false);}
   expect((await query("SELECT has_function_privilege($1,'construction_post(uuid,integer)','EXECUTE') allowed",[role]))[0].allowed).toBe(false);
  }
 });
});

const correct=async(id,values,version=0,actor=1,requestId='404b6ef1-83f5-4dfe-bf49-f2c42d81e108')=>query('select construction_correct_receipt_price($1,$2,$3,$4,$5,$6)',[requestId,id,JSON.stringify(values),version,'Исправление цены накладной',actor]);
describe('Posted receipt price corrections',()=>{
 it('revalues fully consumed receipt, debt and cost snapshot; preserves source and cash',async()=>{
  const id=await document();await post(id);
  const out=await document({kind:'WRITE_OFF',project_id:1,work_type:'Concrete',lines:[{material_id:material,quantity:100}]});await post(out);
  await db.query(`insert into cost_material_usages(id,stock_entry_id,building_id,material_kind,usage_date,quantity,unit,amount,currency,exchange_rate,reason,updated_by) select gen_random_uuid(),id,1,'CONCRETE','2026-10-02',100,'kg',1000,'TJS',10,'Test usage',1 from construction_stock_entries where document_id=$1`,[out]);
  await correct(id,[2000]);
  expect(await sum('construction_stock_entries','value')).toBe(0);
  expect(await sum('construction_settlement_entries','amount')).toBe(2000);
  expect(await sum('cost_material_usages','amount')).toBe(2000);
  expect((await query('select version from cost_material_usages'))[0].version).toBe(2);
  expect((await query('select lines from construction_documents where id=$1',[id]))[0].lines[0].value).toBe(1000);
  expect((await query('select * from cost_material_audit')).length).toBe(1);
  expect((await query('select * from expenses')).length).toBe(0);
 });
 it('replays averages through transfer and mixed receipts, including repeated corrections',async()=>{
  const id=await document();await post(id);
  await post(await document({lines:[{material_id:material,quantity:100,value:3000}]}));
  await post(await document({kind:'TRANSFER',destination_id:destination,lines:[{material_id:material,quantity:40}]}));
  await post(await document({kind:'ISSUE',warehouse_id:destination,project_id:1,work_type:'Work',lines:[{material_id:material,quantity:30}]}));
  await correct(id,[2000]);
  expect(await sum('construction_stock_entries','value',`warehouse_id='${warehouse}'`)).toBe(4000);
  expect(await sum('construction_stock_entries','value',`warehouse_id='${destination}'`)).toBe(250);
  await correct(id,[0],1,1,'404b6ef1-83f5-4dfe-bf49-f2c42d81e109');
  expect(await sum('construction_stock_entries','value',`warehouse_id='${warehouse}'`)).toBe(2400);
  expect(await sum('construction_stock_entries','value',`warehouse_id='${destination}'`)).toBe(150);
 });
 it('supports duplicate materials and cent rounding; never leaves value with zero stock',async()=>{
  const id=await document({lines:[{material_id:material,quantity:3,value:1},{material_id:material,quantity:1,value:2}]});await post(id);
  await post(await document({kind:'WRITE_OFF',project_id:1,work_type:'Work',lines:[{material_id:material,quantity:1},{material_id:material,quantity:3}]}));
  await correct(id,[1.01,2.02]);
  expect(await sum('construction_stock_entries','value')).toBe(0);
  expect(await sum('construction_settlement_entries','amount')).toBe(3.03);
 });
 it('rejects unauthorized, inactive, stale, malformed and unchanged requests atomically',async()=>{
  const id=await document();await post(id);
  await expect(correct(id,[2000],0,2)).rejects.toThrow('прав');
  await expect(correct(id,[],0)).rejects.toThrow('строк');
  await expect(correct(id,[-1])).rejects.toThrow('Стоимость');
  await expect(correct(id,[1.001])).rejects.toThrow('Стоимость');
  await expect(correct(id,[1000])).rejects.toThrow('не изменена');
  await correct(id,[2000]);
  await expect(correct(id,[3000],0,1,'404b6ef1-83f5-4dfe-bf49-f2c42d81e109')).rejects.toThrow('VERSION_CONFLICT');
  expect(await sum('construction_stock_entries','value')).toBe(2000);
  await db.exec('update users set is_active=false where id=1');
  await expect(correct(id,[3000],1)).rejects.toThrow('прав');
 });
 it('deduplicates retries and refuses reuse with another payload',async()=>{
  const id=await document();await post(id);await correct(id,[2000]);await correct(id,[2000]);
  expect((await query('select * from construction_price_corrections')).length).toBe(1);
  await expect(correct(id,[3000])).rejects.toThrow('уже использован');
 });
 it('rolls back all changes when a downstream cost has active payment links',async()=>{
  const id=await document();await post(id);
  const out=await document({kind:'WRITE_OFF',project_id:1,work_type:'Work',lines:[{material_id:material,quantity:100}]});await post(out);
  await db.query(`insert into cost_material_usages(id,stock_entry_id,building_id,material_kind,usage_date,quantity,unit,amount,currency,exchange_rate,reason,updated_by) select gen_random_uuid(),id,1,'CONCRETE','2026-10-02',100,'kg',1000,'TJS',10,'Test usage',1 from construction_stock_entries where document_id=$1`,[out]);
  await db.exec("insert into expenses(id,amount_minor,currency,expense_date) values(10,10000,'TJS','2026-10-02'); insert into cost_material_payment_links(id,usage_id,expense_id,paid_amount,cash_usd_minor,reason,updated_by) select gen_random_uuid(),id,10,100,1000,'Test payment',1 from cost_material_usages");
  await expect(correct(id,[2000])).rejects.toThrow('привязки оплат');
  expect(await sum('construction_settlement_entries','amount')).toBe(1000);
  expect(await sum('construction_stock_entries','value',`document_id='${id}'`)).toBe(1000);
  expect((await query('select * from construction_price_corrections')).length).toBe(0);
 });
 it('protects approved employee reports and restricts RPC and audit table',async()=>{
  const id=await document({party_id:employee});await post(id);
  await post(await document({kind:'ADVANCE_REPORT',party_id:employee,status:'SUBMITTED',lines:[{amount:1000,basis:'Materials',proof:'Invoice',receipt_id:id}]}));
  await expect(correct(id,[2000])).rejects.toThrow('утверждённый');
  for(const role of ['anon','authenticated']){
   expect((await query("select has_function_privilege($1,'construction_correct_receipt_price(uuid,uuid,jsonb,integer,text,integer)','EXECUTE') allowed",[role]))[0].allowed).toBe(false);
   expect((await query("select has_table_privilege($1,'construction_price_corrections','SELECT') allowed",[role]))[0].allowed).toBe(false);
  }
 });
});
