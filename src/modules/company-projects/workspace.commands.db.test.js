import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWriteFixture } from './workspace.write-fixture.js';
import { cashA,cashB } from './workspace.fixture.js';
let db,plaza,tower;
const run=(kind,payload,request=randomUUID(),actor=10,project=plaza)=>db.query('SELECT execute_company_project_command($1,$2,$3,$4,$5::jsonb) AS result',[actor,project,request,kind,JSON.stringify(payload)]);
const money={cash_desk_id:cashA,amount_minor:1000,currency:'USD',date:'2026-11-10'};
const material='10000000-0000-4000-8000-000000000001';
const receipt={kind:'RECEIPT',date:'2026-11-10',currency:'USD',warehouse_id:cashA,party_id:cashA,basis:'Test receipt',lines:[{material_id:material,quantity:10,value:100}]};
beforeAll(async()=>{({db,plaza,tower}=await createWriteFixture());},30000);
afterAll(async()=>db?.close());
describe.sequential('atomic project commands against real domain functions',()=>{
 it('requires a separate current write grant, even for an ADMIN pilot user',async()=>{
  await db.exec("UPDATE company_workspace_access SET write_sections='{}' WHERE user_id=10");
  await expect(run('PAYMENT',{...money,deal_id:1})).rejects.toThrow('WORKSPACE_WRITE_DENIED');
  await db.exec("UPDATE company_workspace_access SET write_sections=ARRAY['deals.write','finance.payments.write','finance.expenses.write','construction.stock.write'] WHERE user_id=10");
 });
 it('posts one payment and FIFO allocation, makes retries idempotent, rejects reuse with changed payload',async()=>{
  const request=randomUUID(),payload={...money,deal_id:1};
  const result=(await run('PAYMENT',payload,request)).rows[0].result;expect(result.resource).toBe('payments');expect(result.idempotent).toBe(false);
  expect((await db.query('SELECT paid_amount_minor FROM deal_payment_schedules WHERE id=1')).rows[0].paid_amount_minor).toBe(1000);
  expect((await run('PAYMENT',payload,request)).rows[0].result).toEqual({...result,idempotent:true});
  await db.exec("UPDATE company_workspace_access SET write_sections='{}' WHERE user_id=10");
  await expect(run('PAYMENT',payload,request)).rejects.toThrow('WORKSPACE_WRITE_DENIED');
  await db.exec("UPDATE company_workspace_access SET write_sections=ARRAY['deals.write','finance.payments.write','finance.expenses.write','construction.stock.write'] WHERE user_id=10");
  await expect(run('PAYMENT',{...payload,amount_minor:2000},request)).rejects.toThrow('WORKSPACE_REQUEST_REUSED');
  expect((await db.query('SELECT * FROM company_project_commands WHERE request_id=$1',[request])).rows).toHaveLength(1);
 });
 it('rejects foreign cash desks/contracts, overpayments, wrong currency and forged attribution without writes',async()=>{
  const before=(await db.query('SELECT count(*)::int AS n FROM payments')).rows[0].n;
  for(const payload of [{...money,cash_desk_id:cashB,deal_id:1},{...money,deal_id:2},{...money,deal_id:1,amount_minor:2147483647},{...money,deal_id:1,currency:'TJS'},{...money,deal_id:1,created_by_user_id:20}])await expect(run('PAYMENT',payload)).rejects.toThrow();
  expect((await db.query('SELECT count(*)::int AS n FROM payments')).rows[0].n).toBe(before);
 });
 it('posts a normal expense through the existing balance check and rolls back insufficient funds',async()=>{
  const result=(await run('EXPENSE',{...money,amount_minor:500,category:'Test',recipient:'Supplier'})).rows[0].result;
  expect(result.resource).toBe('expenses');
  const before=(await db.query('SELECT count(*)::int AS n FROM expenses')).rows[0].n;
  await expect(run('EXPENSE',{...money,amount_minor:999999,category:'Too much'})).rejects.toThrow('INSUFFICIENT_FUNDS');
  expect((await db.query('SELECT count(*)::int AS n FROM expenses')).rows[0].n).toBe(before);
 });
 it('does not spend balances contaminated by another project cash entry',async()=>{
  await db.query("INSERT INTO payments(deal_id,cash_desk_id,amount_minor,currency,payment_date,status) VALUES(2,$1,999,'USD','2026-11-10','ACTIVE')",[cashA]);
  await expect(run('EXPENSE',{...money,amount_minor:1,category:'Blocked'})).rejects.toThrow('CASH_BOOK_REQUIRES_REVIEW');
  await db.query('DELETE FROM payments WHERE deal_id=2 AND cash_desk_id=$1',[cashA]);
 });
 it('creates a project contract draft, reserves its unit and freezes the project director snapshot',async()=>{
  await db.exec("INSERT INTO units(id,floor_id,unit_number,area_m2_x100,price_per_m2_minor,status,unit_kind) VALUES(10,1,'A10',6000,70000,'AVAILABLE','APARTMENT')");
  await db.query("UPDATE company_projects SET director_name='Director A',director_authority='Test authority' WHERE id=$1",[plaza]);
  const payload={unit_id:10,lead_id:1,final_price_minor:4200000,date:'2026-11-10'};
  const r=(await run('DEAL_DRAFT',payload)).rows[0].result;
  const d=(await db.query('SELECT * FROM deals WHERE id=$1',[r.id])).rows[0];expect(d.status).toBe('DRAFT');expect(d.company_project_id).toBe(plaza);expect(d.company_director_snapshot.director_name).toBe('Director A');
  await db.query("UPDATE company_projects SET director_name='Changed director' WHERE id=$1",[plaza]);
  expect((await db.query('SELECT company_director_snapshot FROM deals WHERE id=$1',[r.id])).rows[0].company_director_snapshot.director_name).toBe('Director A');
  await expect(run('DEAL_DRAFT',payload)).rejects.toThrow('UNIT_UNAVAILABLE');
  await expect(db.query('UPDATE deals SET lead_id=2 WHERE id=$1',[r.id])).rejects.toThrow('SCOPED_DEAL_LINK_MISMATCH');
  await expect(db.query('UPDATE deals SET company_project_id=NULL WHERE id=$1',[r.id])).rejects.toThrow('SCOPED_DEAL_CANNOT_CHANGE_PROJECT');
 });
 it('rejects a foreign customer before creating a draft or reserving a unit',async()=>{
  await db.exec("INSERT INTO units(id,floor_id,unit_number,area_m2_x100,price_per_m2_minor,status,unit_kind) VALUES(11,1,'A11',6000,70000,'AVAILABLE','APARTMENT')");
  await expect(run('DEAL_DRAFT',{unit_id:11,lead_id:2,final_price_minor:4200000,date:'2026-11-10'})).rejects.toThrow('LEAD_OUTSIDE_PROJECT');
  expect((await db.query('SELECT status FROM units WHERE id=11')).rows[0].status).toBe('AVAILABLE');
 });
 it('posts receipt and stock ledger together, retries without duplicating stock, then issues from the same project',async()=>{
  const req=randomUUID();const r=(await run('STOCK_POST',receipt,req)).rows[0].result;expect(r.status).toBe('POSTED');
  expect((await run('STOCK_POST',receipt,req)).rows[0].result.idempotent).toBe(true);
  expect((await db.query('SELECT sum(quantity)::float AS n FROM construction_stock_entries')).rows[0].n).toBe(10);
  await run('STOCK_POST',{...receipt,kind:'ISSUE',party_id:undefined,complex_id:1,work_type:'Construction',lines:[{material_id:material,quantity:3}]});
  expect((await db.query('SELECT sum(quantity)::float AS n FROM construction_stock_entries')).rows[0].n).toBe(7);
 });
 it('rolls back the draft and ledgers on insufficient stock, foreign destination/supplier or complex',async()=>{
  const before=(await db.query('SELECT count(*)::int AS n FROM construction_documents')).rows[0].n;
  for(const payload of [{...receipt,warehouse_id:cashB},{...receipt,party_id:cashB},{...receipt,kind:'TRANSFER',destination_id:cashB},{...receipt,kind:'ISSUE',complex_id:2,work_type:'Foreign'},{...receipt,kind:'ISSUE',complex_id:1,work_type:'Work',lines:[{material_id:material,quantity:999}]}])await expect(run('STOCK_POST',payload)).rejects.toThrow();
  expect((await db.query('SELECT count(*)::int AS n FROM construction_documents')).rows[0].n).toBe(before);
 });
 it('accepts TJS against a USD contract and credits its historical USD equivalent to the schedule',async()=>{
  await db.exec("INSERT INTO deal_payment_schedules(id,deal_id,due_date,amount_minor,paid_amount_minor,status) VALUES(50,1,'2026-12-01',1000000,0,'UPCOMING')");
  const p=(await run('PAYMENT',{...money,currency:'TJS',exchange_rate:9.24,amount_minor:92400,deal_id:1})).rows[0].result;
  const stored=(await db.query('SELECT amount_minor,amount_usd,amount_tjs,currency FROM payments WHERE id=$1',[p.id])).rows[0];
  expect(stored.amount_minor).toBe(92400);expect(Number(stored.amount_usd)).toBe(100);expect(Number(stored.amount_tjs)).toBe(924);expect(stored.currency).toBe('TJS');
  expect((await db.query('SELECT paid_amount_minor FROM deal_payment_schedules WHERE id=50')).rows[0].paid_amount_minor).toBe(10100);
  const e=(await run('EXPENSE',{...money,currency:'TJS',exchange_rate:9.24,amount_minor:9240,category:'TJS cost'})).rows[0].result;
  expect(Number((await db.query('SELECT amount_usd FROM expenses WHERE id=$1',[e.id])).rows[0].amount_usd)).toBe(10);
 });
 it.each(['anon','authenticated'])('does not expose commands or command history to %s',async role=>{
  await db.exec('SET ROLE '+role);try{await expect(run('PAYMENT',{...money,deal_id:1})).rejects.toThrow('permission denied');await expect(db.query('SELECT * FROM company_project_commands')).rejects.toThrow('permission denied');}finally{await db.exec('RESET ROLE');}
 });
});
