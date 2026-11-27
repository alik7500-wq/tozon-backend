import {it,expect,beforeEach,afterEach} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync,readdirSync} from 'node:fs';
import {STOCK_ORDER,stockImportSQL} from './company-project-stock-import.mjs';
import {TEST_IMPORT_REF} from './company-project-catalog-import.mjs';
let db;
const batch='00000000-0000-4000-8000-000000000035',doc='00000000-0000-4000-8000-000000000036';
beforeEach(async()=>{
 db=new PGlite();
 await db.exec(`SET TIME ZONE 'UTC';CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA tozon_import;CREATE SCHEMA tozon_internal;
 CREATE TABLE tozon_import.batches(id uuid PRIMARY KEY,source_ref text,snapshot_at timestamptz,description text);
 CREATE TABLE tozon_import.rows(batch_id uuid,table_name text,source_id text,target_id text,payload_hash text,PRIMARY KEY(batch_id,table_name,source_id),UNIQUE(table_name,target_id));
 CREATE TABLE construction_warehouses(id uuid PRIMARY KEY,name text);CREATE TABLE construction_materials(id uuid PRIMARY KEY,name text);
 CREATE TABLE construction_documents(id uuid PRIMARY KEY,number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,status text,lines jsonb DEFAULT '[]');
 CREATE TABLE construction_stock_entries(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,quantity numeric,value numeric);
 CREATE TABLE construction_settlement_entries(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,amount numeric);
 CREATE TABLE construction_price_corrections(id uuid PRIMARY KEY,before_lines jsonb,after_lines jsonb);
 CREATE TABLE construction_expense_settlement_audit(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,expense_id integer NOT NULL,operation text,before_data jsonb,after_data jsonb);
 CREATE TABLE construction_report_receipts(receipt_id uuid PRIMARY KEY,report_id uuid);
 CREATE TABLE payments(id integer PRIMARY KEY,amount_minor bigint);CREATE TABLE expenses(id integer PRIMARY KEY,amount_minor bigint);
 INSERT INTO payments VALUES(1,100);INSERT INTO expenses VALUES(1,20);
 CREATE TABLE construction_settings(id integer PRIMARY KEY,start_date date);INSERT INTO construction_settings VALUES(1,'2026-10-29');
 CREATE TABLE tozon_internal.customer_pko_counter(id integer PRIMARY KEY,last_number bigint);INSERT INTO tozon_internal.customer_pko_counter VALUES(1,1);
 CREATE TABLE sms_events(id integer);CREATE TABLE sms_messages(id integer);CREATE TABLE tasks(id integer);CREATE TABLE user_notifications(id integer);
 `);
 const cash=readFileSync('supabase/migrations/'+readdirSync('supabase/migrations').find(n=>n.endsWith('_company_project_legacy_cash_import.sql')),'utf8');
 await db.exec(cash.match(/CREATE FUNCTION tozon_internal\.is_verified_cash_import[\s\S]*?END \$guard\$;/)[0]);
 await db.exec('REVOKE ALL ON SCHEMA tozon_import FROM PUBLIC,anon,authenticated,service_role;REVOKE ALL ON FUNCTION tozon_internal.is_verified_cash_import(jsonb) FROM PUBLIC;GRANT EXECUTE ON FUNCTION tozon_internal.is_verified_cash_import(jsonb) TO service_role');
 const migration=readdirSync('supabase/migrations').find(n=>n.endsWith('_company_project_legacy_stock_import.sql'));await db.exec(readFileSync('supabase/migrations/'+migration,'utf8'));
});
afterEach(async()=>db.close());
const ownerContext=async()=>{
 await db.query("INSERT INTO tozon_import.batches(id,source_ref) VALUES($1,'yeslzrrcwgcqfxhgbrqk')",[batch]);
 await db.query("SELECT set_config('tozon.import_batch',$1,false)",[batch]);
};
it('imports original identity numbers and deleted-expense audit without cash changes, then advances the native sequence',async()=>{
 const cashHashes=(await db.query(`SELECT 'payments' table_name,id::text id,md5(to_jsonb(r)::text) hash FROM payments r UNION ALL SELECT 'expenses',id::text,md5(to_jsonb(r)::text) FROM expenses r`)).rows;
 const rows={construction_documents:[{id:doc,number:5,status:'POSTED',lines:[]}],construction_stock_entries:[{id:101,quantity:1.25,value:12.35}],construction_expense_settlement_audit:[{id:101,expense_id:null,source_expense_id:99,operation:'DELETE',before_data:{id:99,amount_minor:20},after_data:null}]};
 const tables=STOCK_ORDER.map(table_name=>{
  const payload=rows[table_name]||[],pk_column=table_name==='construction_report_receipts'?'receipt_id':'id';
  return {table_name,rows:payload.length,keys:payload.map(r=>({source_id:String(r[pk_column]),target_id:String(r[pk_column])})),pk_column,columns:payload.length?Object.keys(payload[0]):[pk_column],payload_b64:Buffer.from(JSON.stringify(payload)).toString('base64')};
 });
 const sql=stockImportSQL({targetRef:TEST_IMPORT_REF,batchId:batch,snapshotAt:'2026-11-26T18:52:38Z',tables,baseline:[],parentMap:[],cashHashes,sourceSettingsB64:Buffer.from('[{"start_date":"2026-10-01"}]').toString('base64')});
 await db.exec(sql);
 expect((await db.query('SELECT number FROM construction_documents')).rows[0].number).toBe(5);
 expect((await db.query('SELECT expense_id,source_expense_id FROM construction_expense_settlement_audit')).rows[0]).toEqual({expense_id:null,source_expense_id:99});
 await db.query("INSERT INTO construction_documents(id,status) VALUES($1,'DRAFT')",['00000000-0000-4000-8000-000000000037']);
 expect((await db.query("SELECT max(number) n FROM construction_documents")).rows[0].n).toBe(6);
 expect((await db.query("SELECT start_date::text d FROM construction_settings")).rows[0].d).toBe('2026-10-29');
 expect((await db.query('SELECT count(*)::int n FROM tozon_import.rows')).rows[0].n).toBe(3);
});
it('rejects forged import markers and keeps ordinary service-role catalog writes working',async()=>{
 await ownerContext();
 await db.exec('GRANT USAGE ON SCHEMA public,tozon_internal TO service_role;GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;SET ROLE service_role');
 await expect(db.query('INSERT INTO construction_warehouses VALUES($1,\'source\',$2)',[doc,batch])).rejects.toThrow('OWNER_IMPORT_TRANSACTION_REQUIRED');
 await db.query('INSERT INTO construction_warehouses(id,name) VALUES($1,\'native\')',[doc]);
 expect((await db.query('SELECT count(*)::int n FROM construction_warehouses')).rows[0].n).toBe(1);
 await expect(db.exec('SELECT * FROM tozon_import.contexts')).rejects.toThrow();
});
it('keeps imported stock immutable and permits a missing expense only with verified historical provenance',async()=>{
 await expect(db.exec("INSERT INTO construction_expense_settlement_audit(expense_id,operation) VALUES(NULL,'DELETE')")).rejects.toThrow();
 await db.exec("INSERT INTO construction_expense_settlement_audit(expense_id,operation) VALUES(1,'UPDATE')");
 expect((await db.query('SELECT source_import_batch_id,source_expense_id FROM construction_expense_settlement_audit')).rows[0]).toEqual({source_import_batch_id:null,source_expense_id:null});
 await ownerContext();
 await db.query('INSERT INTO construction_warehouses VALUES($1,\'source\',$2)',[doc,batch]);
 await expect(db.query('UPDATE construction_warehouses SET name=\'changed\' WHERE id=$1',[doc])).rejects.toThrow('IMPORTED_STOCK_HISTORY_READ_ONLY');
 await expect(db.query('DELETE FROM construction_warehouses WHERE id=$1',[doc])).rejects.toThrow('IMPORTED_STOCK_HISTORY_READ_ONLY');
 await expect(db.query('UPDATE construction_warehouses SET source_import_batch_id=NULL WHERE id=$1',[doc])).rejects.toThrow('IMPORT_SOURCE_IMMUTABLE');
 await expect(db.exec("INSERT INTO construction_expense_settlement_audit(expense_id,source_expense_id,operation) VALUES(NULL,99,'DELETE')")).rejects.toThrow();
});
it('refuses a production destination before generating SQL',()=>{
 expect(()=>stockImportSQL({targetRef:'yeslzrrcwgcqfxhgbrqk'})).toThrow('TEST_DESTINATION_REQUIRED');
});
