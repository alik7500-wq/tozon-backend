import {PGlite} from '@electric-sql/pglite';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {STOCK_ORDER,stockImportSQL} from './company-project-stock-import.mjs';
import {TEST_IMPORT_REF} from './company-project-catalog-import.mjs';
const root=resolve(process.argv[2]),read=n=>JSON.parse(readFileSync(root+'/'+n));
const schema=read('schema.json'),fresh=read('stage35-target.json'),before=read('stage35-before.json');
const source=new PGlite(root+'/staging-pg');
const tables=[],referenced=new Set();
const stockTotalsSQL=`SELECT w.source_id#>>'{}' warehouse_id,m.source_id#>>'{}' material_id,c.payload->>'currency' currency,sum((c.payload->>'quantity')::numeric)::text quantity,sum((c.payload->>'value')::numeric)::text value FROM stock_payload c JOIN staging_identity_map w ON w.table_name='construction_warehouses' AND w.staged_id=c.payload->'warehouse_id' JOIN staging_identity_map m ON m.table_name='construction_materials' AND m.staged_id=c.payload->'material_id' WHERE c.table_name='construction_stock_entries' GROUP BY 1,2,3 ORDER BY 1,2,3`;
await source.query(`CREATE TEMP TABLE stock_payload AS SELECT * FROM staged_rows WHERE table_name=ANY($1::text[])`,[STOCK_ORDER]);
// Live document lines must resolve to the imported material catalog. Historical
// price/audit JSON is immutable evidence and intentionally retains original IDs.
const unknown=(await source.query(`SELECT count(*)::int n FROM stock_payload c CROSS JOIN LATERAL jsonb_array_elements(c.payload->'lines') l WHERE c.table_name='construction_documents' AND (l->>'material_id' IS NULL OR NOT EXISTS(SELECT 1 FROM staging_identity_map m WHERE m.table_name='construction_materials' AND m.source_id=l->'material_id'))`)).rows[0].n;
if(unknown)throw Error('DOCUMENT_LINE_MATERIAL_MISSING');
await source.exec(`UPDATE stock_payload c SET payload=jsonb_set(c.payload,'{lines}',coalesce((SELECT jsonb_agg(l.value||jsonb_build_object('material_id',m.staged_id) ORDER BY l.ordinality) FROM jsonb_array_elements(c.payload->'lines') WITH ORDINALITY l JOIN staging_identity_map m ON m.table_name='construction_materials' AND m.source_id=l.value->'material_id'),'[]'::jsonb)) WHERE c.table_name='construction_documents'`);
// This source field lacks a declared FK but is a live link, unlike before/after JSON.
const deletedExpenseAudit=(await source.query(`SELECT count(*)::int audit_rows,count(DISTINCT c.payload->>'expense_id')::int expenses FROM stock_payload c WHERE c.table_name='construction_expense_settlement_audit' AND c.payload->>'expense_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM staging_identity_map m WHERE m.table_name='expenses' AND m.source_id=c.payload->'expense_id')`)).rows[0];
const unprovenDeleted=(await source.query(`SELECT count(*)::int n FROM stock_payload c WHERE c.table_name='construction_expense_settlement_audit' AND c.payload->>'expense_id' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM staging_identity_map m WHERE m.table_name='expenses' AND m.source_id=c.payload->'expense_id') AND NOT EXISTS(SELECT 1 FROM source_rows a WHERE a.table_name=c.table_name AND a.payload->'expense_id'=c.payload->'expense_id' AND a.payload->>'operation'='DELETE')`)).rows[0].n;
if(unprovenDeleted)throw Error('UNPROVEN_MISSING_AUDIT_EXPENSE');
await source.exec(`UPDATE stock_payload c SET payload=(c.payload||jsonb_build_object('source_expense_id',c.payload->'expense_id'))||jsonb_build_object('expense_id',coalesce((SELECT m.staged_id FROM staging_identity_map m WHERE m.table_name='expenses' AND m.source_id=c.payload->'expense_id'),'null'::jsonb)) WHERE c.table_name='construction_expense_settlement_audit'`);
for(const fk of schema.foreign_keys.filter(f=>STOCK_ORDER.includes(f.child_table))){
 const child=fk.child_columns[0],parent=fk.parent_columns[0];
 const r=(await source.query(`SELECT count(*)::int n FROM stock_payload c LEFT JOIN staged_rows p ON p.table_name=$2 AND p.payload->>$4=c.payload->>$3 WHERE c.table_name=$1 AND c.payload->>$3 IS NOT NULL AND p.ordinal IS NULL`,[fk.child_table,fk.parent_table,child,parent])).rows[0];
 if(r.n)throw Error('FK_PROJECTION_MISSING:'+fk.name);
 if(!STOCK_ORDER.includes(fk.parent_table))for(const r of (await source.query(`SELECT DISTINCT payload->>$2 id FROM stock_payload WHERE table_name=$1 AND payload->>$2 IS NOT NULL`,[fk.child_table,child])).rows)referenced.add(fk.parent_table+'|'+r.id);
}
for(const r of (await source.query(`SELECT DISTINCT payload->>'expense_id' id FROM stock_payload WHERE table_name='construction_expense_settlement_audit' AND payload->>'expense_id' IS NOT NULL`)).rows)referenced.add('expenses|'+r.id);
for(const name of STOCK_ORDER){
 const pk_column=schema.primary_keys.find(p=>p.table_name===name).columns[0];
 const row=(await source.query(`SELECT encode(convert_to(coalesce(jsonb_agg(payload ORDER BY ordinal),'[]'::jsonb)::text,'UTF8'),'base64') payload_b64,count(*)::int rows FROM stock_payload WHERE table_name=$1`,[name])).rows[0];
 const keys=(await source.query(`SELECT s.payload->>$2 source_id,d.payload->>$2 target_id FROM source_rows s JOIN stock_payload d USING(table_name,ordinal) WHERE s.table_name=$1 ORDER BY s.ordinal`,[name,pk_column])).rows;
 tables.push({table_name:name,...row,keys,pk_column,columns:[...schema.tables.find(t=>t.table_name===name).columns.map(c=>c.name),...(name==='construction_expense_settlement_audit'?['source_expense_id']:[])]});
}
// Compare all non-reference business fields to the original snapshot in PostgreSQL.
for(const name of STOCK_ORDER){
 const refs=new Set(['id',...schema.foreign_keys.filter(f=>f.child_table===name).flatMap(f=>f.child_columns)]);
 if(name==='construction_expense_settlement_audit'){refs.add('expense_id');refs.add('source_expense_id');}
 if(name==='construction_documents')refs.add('lines');
 const r=(await source.query(`SELECT count(*)::int n FROM source_rows s JOIN stock_payload d USING(table_name,ordinal) WHERE s.table_name=$1 AND (s.payload-$2::text[]) IS DISTINCT FROM (d.payload-$2::text[])`,[name,[...refs]])).rows[0];
 if(r.n)throw Error('BUSINESS_FIELD_DRIFT:'+name);
}
const lineDrift=(await source.query(`SELECT count(*)::int n FROM source_rows s JOIN stock_payload d USING(table_name,ordinal) CROSS JOIN LATERAL jsonb_array_elements(s.payload->'lines') WITH ORDINALITY a CROSS JOIN LATERAL jsonb_array_elements(d.payload->'lines') WITH ORDINALITY b WHERE s.table_name='construction_documents' AND a.ordinality=b.ordinality AND (a.value-'material_id') IS DISTINCT FROM (b.value-'material_id')`)).rows[0].n;
if(lineDrift)throw Error('LINE_BUSINESS_FIELD_DRIFT');
if((await source.query(`SELECT count(*)::int n FROM source_rows s JOIN stock_payload d USING(table_name,ordinal) WHERE s.table_name='construction_expense_settlement_audit' AND s.payload->'expense_id' IS DISTINCT FROM d.payload->'source_expense_id'`)).rows[0].n)throw Error('AUDIT_SOURCE_EXPENSE_DRIFT');
const totals={stock:(await source.query(stockTotalsSQL)).rows,settlements:(await source.query(`SELECT m.source_id#>>'{}' party_id,c.payload->>'currency' currency,c.payload->>'account' account,sum((c.payload->>'amount')::numeric)::text amount FROM stock_payload c JOIN staging_identity_map m ON m.table_name='construction_parties' AND m.staged_id=c.payload->'party_id' WHERE c.table_name='construction_settlement_entries' GROUP BY 1,2,3 ORDER BY 1,2,3`)).rows};
await source.close();
const parentMap=before.import_map.filter(r=>referenced.has(r.table_name+'|'+r.target_id)).map(({table_name,source_id,target_id,payload_hash})=>({table_name,source_id,target_id,payload_hash}));
if(parentMap.length!==referenced.size)throw Error('PARENT_LEDGER_MISSING');
const batchId=randomUUID(),args={targetRef:TEST_IMPORT_REF,batchId,snapshotAt:read('source-manifest.json').snapshot_at,tables,baseline:before.baseline||[],parentMap,cashHashes:before.cash_hashes,sourceSettingsB64:readFileSync(root+'/source/construction_settings.b64','utf8')};
const sql=stockImportSQL(args),db=new PGlite();
try{
 await db.exec(`SET TIME ZONE 'UTC';CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA tozon_internal;CREATE SCHEMA tozon_import;
 CREATE TABLE tozon_import.batches(id uuid PRIMARY KEY,source_ref text,snapshot_at timestamptz,description text,created_at timestamptz DEFAULT now());
 CREATE TABLE tozon_import.rows(batch_id uuid REFERENCES tozon_import.batches(id),table_name text,source_id text,target_id text,payload_hash text,PRIMARY KEY(batch_id,table_name,source_id),UNIQUE(table_name,target_id));
 CREATE TABLE public.users(id integer PRIMARY KEY);CREATE TABLE public.projects(id integer PRIMARY KEY);CREATE TABLE public.construction_parties(id uuid PRIMARY KEY);
 CREATE TABLE public.construction_expense_settlements(party_id uuid,currency text,account text);
 CREATE TABLE tozon_internal.customer_pko_counter(id integer PRIMARY KEY,last_number bigint);INSERT INTO tozon_internal.customer_pko_counter VALUES(1,1);`);
 const old=read('target-before-stage32.json'),cash=read('stage34-target.json');
 const create=async(name,cols)=>{
  const parts=cols.map(c=>{
   let type=c.data_type==='ARRAY'?'text[]':c.data_type,def=c.column_default;
   const identity=before.identity.find(g=>g.table_name===name&&g.column_name===c.column_name);
   if(def?.startsWith('nextval(')){type=type==='bigint'?'bigserial':'serial';def=null;}
   return `"${c.column_name}" ${type}${identity?' GENERATED ALWAYS AS IDENTITY':def?' DEFAULT '+def:''}${c.is_nullable==='NO'?' NOT NULL':''}`;
  });await db.exec(`CREATE TABLE public.${name}(${parts.join(',')})`);
 };
 for(const b of new Set(before.import_map.map(r=>r.batch_id)))await db.query(`INSERT INTO tozon_import.batches(id,source_ref) VALUES($1,'yeslzrrcwgcqfxhgbrqk')`,[b]);
 await db.query(`INSERT INTO tozon_import.rows SELECT * FROM jsonb_populate_recordset(NULL::tozon_import.rows,$1::jsonb)`,[JSON.stringify(before.import_map)]);
 for(const name of ['users','projects','construction_parties'])for(const r of before.import_map.filter(r=>r.table_name===name))await db.query(`INSERT INTO public.${name}(id) VALUES($1)`,[r.target_id]);
 for(const name of ['payments','expenses']){
  await create(name,cash.columns.filter(c=>c.table_name===name));await db.exec(`ALTER TABLE public.${name} ADD COLUMN source_import_batch_id uuid;ALTER TABLE public.${name} ADD PRIMARY KEY(id)`);
  await db.query(`INSERT INTO public.${name} SELECT * FROM jsonb_populate_recordset(NULL::public.${name},convert_from(decode($1,'base64'),'UTF8')::jsonb)`,[readFileSync(root+'/stage35-current-'+name+'.b64','utf8')]);
 }
 await create('construction_settings',old.columns.filter(c=>c.table_name==='construction_settings'));
 await db.query(`INSERT INTO construction_settings SELECT * FROM jsonb_populate_record(NULL::construction_settings,$1::jsonb)`,[JSON.stringify(before.settings)]);
 for(const name of STOCK_ORDER)await create(name,fresh.columns.filter(c=>c.table_name===name));
 for(const c of fresh.constraints.filter(c=>c.contype!=='f'))await db.exec(`ALTER TABLE public.${c.table_name} ADD CONSTRAINT "${c.conname}" ${c.definition}`);
 for(const c of fresh.constraints.filter(c=>c.contype==='f'))await db.exec(`ALTER TABLE public.${c.table_name} ADD CONSTRAINT "${c.conname}" ${c.definition}`);
 for(const idx of fresh.indexes)if(!fresh.constraints.some(c=>c.conname===idx.indexname))await db.exec(idx.indexdef);
 for(const t of read('stage35-baseline.json').tables)await db.query(`INSERT INTO public.${t.table_name} OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_recordset(NULL::public.${t.table_name},convert_from(decode($1,'base64'),'UTF8')::jsonb)`,[t.payload_b64]);
 for(const name of ['sms_events','sms_messages','tasks','user_notifications']){await db.exec(`CREATE TABLE public.${name}(id integer GENERATED ALWAYS AS IDENTITY)`);const key=name==='user_notifications'?'notifications':name;for(let i=0;i<before.background[key];i++)await db.exec(`INSERT INTO public.${name} DEFAULT VALUES`);}
 const verifyFunction=readFileSync('supabase/migrations/'+readdirSync('supabase/migrations').find(n=>n.endsWith('_company_project_legacy_cash_import.sql')),'utf8').match(/CREATE FUNCTION tozon_internal\.is_verified_cash_import[\s\S]*?END \$guard\$;/)[0];
 await db.exec(verifyFunction);for(const f of fresh.functions)await db.exec(f.definition);for(const t of fresh.triggers)await db.exec(t.definition);
 const migration=readdirSync('supabase/migrations').find(n=>n.endsWith('_company_project_legacy_stock_import.sql'));await db.exec(readFileSync('supabase/migrations/'+migration,'utf8'));
 await db.exec(sql);
 const stock=(await db.query(`SELECT w.source_id warehouse_id,m.source_id material_id,e.currency,sum(e.quantity)::text quantity,sum(e.value)::text value FROM construction_stock_entries e JOIN tozon_import.rows w ON w.table_name='construction_warehouses' AND w.target_id=e.warehouse_id::text JOIN tozon_import.rows m ON m.table_name='construction_materials' AND m.target_id=e.material_id::text WHERE e.source_import_batch_id=$1 GROUP BY 1,2,3 ORDER BY 1,2,3`,[batchId])).rows;
 const settlements=(await db.query(`SELECT m.source_id party_id,e.currency,e.account,sum(e.amount)::text amount FROM construction_settlement_entries e JOIN tozon_import.rows m ON m.table_name='construction_parties' AND m.target_id=e.party_id::text WHERE e.source_import_batch_id=$1 GROUP BY 1,2,3 ORDER BY 1,2,3`,[batchId])).rows;
 if(JSON.stringify({stock,settlements})!==JSON.stringify(totals))throw Error('NUMERIC_BALANCE_DRIFT');
 const imported=(await db.query(`SELECT table_name,count(*)::int rows FROM tozon_import.rows WHERE batch_id=$1 GROUP BY table_name ORDER BY table_name`,[batchId])).rows;
 const report={batch_id:batchId,snapshot_at:args.snapshotAt,rows:imported.reduce((n,t)=>n+t.rows,0),tables:imported,typed_rehearsal:true,exact_stock_and_settlement_totals:true,source_business_fields_preserved:true,document_material_lines_remapped:true,audit_json_unchanged:true,deleted_expense_history:deletedExpenseAudit,source_settings_archived_not_applied:true,sql_bytes:Buffer.byteLength(sql)};
 writeFileSync(root+'/stage35-stock-import.sql',sql);writeFileSync(root+'/stage35-stock-batch.json',JSON.stringify(report,null,2)+'\n');writeFileSync(root+'/stage35-source-totals.json',JSON.stringify(totals,null,2)+'\n');console.log(JSON.stringify(report));
}catch(e){console.error(JSON.stringify({message:e.message,code:e.code,table:e.table,constraint:e.constraint}));process.exitCode=1;}finally{await db.close();}
