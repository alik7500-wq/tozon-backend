import {it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
it('stores signed results while isolating access from public clients',async()=>{
 const db=new PGlite();
 try {
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create table dictionaries(id uuid primary key);create table payments(id int primary key);create table expenses(id int primary key);create table cash_transfers(id uuid primary key);create table users(id int primary key);`);
 await db.exec(readFileSync('supabase/migrations/20261028122239_barter_realization_results.sql','utf8'));
 const perms=await db.query(`select has_table_privilege('anon','barter_realization_results','SELECT') as anon,has_table_privilege('service_role','barter_realization_results','SELECT') as service`);
 expect(perms.rows[0]).toEqual({anon:false,service:true});
 await db.exec(`insert into dictionaries values('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');insert into payments values(1),(2);insert into expenses values(1);insert into cash_transfers values('00000000-0000-0000-0000-000000000003'),('00000000-0000-0000-0000-000000000004');insert into users values(1);insert into barter_realization_results(result_cash_desk_id,source_cash_desk_id,purchase_payment_id,sale_transfer_id,reclassified_transfer_id,reclassified_payment_id,reclassified_expense_id,asset_name,realization_date,cost_tjs_minor,proceeds_tjs_minor,exchange_rate,source_currency,created_by,source_snapshot) values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',1,'00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',2,1,'Genesis','2026-10-28',10000000,8500000,9.25,'USD',1,'{}');`);
 const result=await db.query('select result_tjs_minor::text,result_usd_minor::text from barter_realization_results');
 expect(result.rows[0]).toEqual({result_tjs_minor:'-1500000',result_usd_minor:'-162162'});
 }finally{await db.close()}
},30000);
