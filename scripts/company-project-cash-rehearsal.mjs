import {PGlite} from '@electric-sql/pglite';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CASH_ORDER,cashImportSQL} from './company-project-cash-import.mjs';
import {TEST_IMPORT_REF} from './company-project-catalog-import.mjs';
const root=resolve(process.argv[2]);
const read=n=>JSON.parse(readFileSync(root+'/'+n));
const schema=read('schema.json'),old=read('target-before-stage32.json'),fresh=read('stage34-target.json'),before=read('stage34-before.json'),generated=read('stage34-generated.json');
const source=new PGlite(root+'/staging-pg');
const referenced=new Set();
const tables=[],parents=[],missing=[];
// Source files and the Stage 31 staging store remain untouched. Fix undeclared
// references only in this temporary projection; immutable audit snapshots stay original.
await source.exec(`CREATE TEMP TABLE cash_payload AS SELECT * FROM staged_rows WHERE table_name IN ('payments','expenses','cash_transfers','barter_realization_results','dictionaries','construction_parties');`);
for(const table of ['payments','expenses'])for(const [column,parent] of [['voided_by','users'],['transfer_id','cash_transfers']]){
 const absent=await source.query(`SELECT count(*)::int n FROM source_rows s WHERE s.table_name=$1 AND s.payload->>$2 IS NOT NULL AND NOT EXISTS(SELECT 1 FROM staging_identity_map m WHERE m.table_name=$3 AND m.source_id#>>'{}'=s.payload->>$2)`,[table,column,parent]);
 if(absent.rows[0].n)missing.push({table,column,missing:absent.rows[0].n});
 if(parent==='users'&&absent.rows[0].n)throw Error('UNDECLARED_USER_REFERENCE_MISSING');
 await source.query(`UPDATE cash_payload c SET payload=jsonb_set(c.payload,ARRAY[$2],coalesce((SELECT m.staged_id FROM staging_identity_map m WHERE m.table_name=$3 AND m.source_id#>>'{}'=s.payload->>$2),to_jsonb(md5('TOZON_STAGE31|'||$3||'|'||(s.payload->>$2))::uuid))) FROM source_rows s WHERE c.table_name=$1 AND s.table_name=c.table_name AND s.ordinal=c.ordinal AND s.payload->>$2 IS NOT NULL`,[table,column,parent]);
}
// Every declared FK retains its already staged identity. No external parents may be omitted.
for(const fk of schema.foreign_keys.filter(f=>CASH_ORDER.includes(f.child_table))){
 const child=fk.child_columns[0],parent=fk.parent_columns[0];
 const r=await source.query(`SELECT count(*)::int n FROM cash_payload c LEFT JOIN staged_rows p ON p.table_name=$2 AND p.payload->>$4=c.payload->>$3 WHERE c.table_name=$1 AND c.payload->>$3 IS NOT NULL AND p.ordinal IS NULL`,[fk.child_table,fk.parent_table,child,parent]);
 if(r.rows[0].n)throw Error('FK_PROJECTION_MISSING:'+fk.name);
 if(!CASH_ORDER.includes(fk.parent_table)){
  const refs=(await source.query(`SELECT DISTINCT payload->>$2 id FROM cash_payload WHERE table_name=$1 AND payload->>$2 IS NOT NULL`,[fk.child_table,child])).rows;
  for(const r of refs)referenced.add(fk.parent_table+'|'+r.id);
 }
}
for(const name of CASH_ORDER){
 const row=(await source.query(`SELECT encode(convert_to(coalesce(jsonb_agg(payload ORDER BY ordinal),'[]'::jsonb)::text,'UTF8'),'base64') payload_b64,count(*)::int rows FROM cash_payload WHERE table_name=$1`,[name])).rows[0];
 const keys=(await source.query(`SELECT s.payload->>'id' source_id,d.payload->>'id' target_id FROM source_rows s JOIN cash_payload d USING(table_name,ordinal) WHERE s.table_name=$1 ORDER BY s.ordinal`,[name])).rows;
 tables.push({table_name:name,...row,keys,columns:schema.tables.find(t=>t.table_name===name).columns.map(c=>c.name),generated_columns:generated.filter(c=>c.table_name===name).map(c=>c.column_name)});
}
for(const name of ['users','deals','deal_payment_schedules'])parents.push({table_name:name,payload:(await source.query(`SELECT jsonb_agg(payload ORDER BY ordinal)::text p FROM staged_rows WHERE table_name=$1`,[name])).rows[0].p});
const totals=await source.query(`SELECT table_name,payload->>'currency' currency,coalesce(payload->>'status','ACTIVE') status,sum((payload->>'amount_minor')::numeric)::text amount_minor FROM source_rows WHERE table_name IN ('payments','expenses','cash_transfers') GROUP BY 1,2,3 ORDER BY 1,2,3`);
const originalGroups=await source.query(`SELECT count(DISTINCT payload->>'conversion_id')::int conversion_groups,count(*)::int conversion_legs FROM source_rows WHERE table_name IN ('payments','expenses') AND payload->>'conversion_id' IS NOT NULL`);
// Hash/count checks stay in PostgreSQL, without parsing any monetary number in JS.
await source.close();
const batchId=randomUUID();
const parentMap=before.import_map.filter(r=>referenced.has(r.table_name+'|'+r.target_id)).map(({table_name,source_id,target_id,payload_hash})=>({table_name,source_id,target_id,payload_hash}));
if(parentMap.length!==referenced.size)throw Error('REQUIRED_PARENT_LEDGER_MISSING');
const sql=cashImportSQL({targetRef:TEST_IMPORT_REF,batchId,snapshotAt:read('source-manifest.json').snapshot_at,tables,baseline:before.baseline,parentMap});
if(Buffer.byteLength(sql)>1950000)throw Error('SQL_REQUIRES_PRIVATE_CHUNK_STAGING');
const db=new PGlite();
try{
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA tozon_internal;CREATE SCHEMA tozon_import;
 CREATE TABLE tozon_import.batches(id uuid PRIMARY KEY,source_ref text,snapshot_at timestamptz,description text,created_at timestamptz DEFAULT now());
 CREATE TABLE tozon_import.rows(batch_id uuid REFERENCES tozon_import.batches(id),table_name text,source_id text,target_id text,payload_hash text,PRIMARY KEY(batch_id,table_name,source_id),UNIQUE(table_name,target_id));
 CREATE TABLE tozon_internal.customer_pko_counter(id integer PRIMARY KEY,last_number bigint);
 CREATE TABLE public.company_project_cash_desks(company_project_id uuid,cash_desk_id uuid);`);
 const names=[...CASH_ORDER,'users','deals','deal_payment_schedules','crm_document_settings','construction_documents','construction_expense_settlement_audit','construction_settings'];
 for(const name of names){
  const cols=(CASH_ORDER.includes(name)?fresh.columns:old.columns).filter(c=>c.table_name===name);
  const parts=cols.map(c=>{let type=c.data_type==='ARRAY'?'text[]':c.data_type,def=c.column_default;const g=generated.find(g=>g.table_name===name&&g.column_name===c.column_name);if(def?.startsWith('nextval(')){type=type==='bigint'?'bigserial':'serial';def=null;}return `"${c.column_name}" ${type}${g?' GENERATED ALWAYS AS ('+g.generation_expression+') STORED':def?' DEFAULT '+def:''}${c.is_nullable==='NO'?' NOT NULL':''}`;});
  await db.exec(`CREATE TABLE public.${name}(${parts.join(',')})`);
  // Deal namespace migration was independently rehearsed in Stage 33. These are
  // parent anchors; only their PK is relevant to the cash graph checked here.
  const cons=(CASH_ORDER.includes(name)?fresh.constraints:old.constraints).filter(c=>c.table_name===name&&c.contype!=='f'&&!(name==='deals'&&c.conname==='deals_contract_number_key'));
  for(const c of cons)await db.exec(`ALTER TABLE public.${name} ADD CONSTRAINT "${c.conname}" ${c.definition}`);
 }
 for(const t of ['sms_events','sms_messages','tasks','user_notifications'])await db.exec(`CREATE TABLE public.${t}(id integer GENERATED ALWAYS AS IDENTITY)`);
 for(let i=0;i<before.background.notifications;i++)await db.exec('INSERT INTO user_notifications DEFAULT VALUES');
 const insert=async(name,payload)=>{
  const cols=(CASH_ORDER.includes(name)?fresh.columns:old.columns).filter(c=>c.table_name===name&&!generated.some(g=>g.table_name===name&&g.column_name===c.column_name)).map(c=>'"'+c.column_name+'"').join(',');
  return db.query(`INSERT INTO public.${name}(${cols}) SELECT ${cols} FROM jsonb_populate_recordset(NULL::public.${name},${name==='users'?`(SELECT jsonb_agg(value||'{"password_hash":"!DISABLED_REHEARSAL"}'::jsonb) FROM jsonb_array_elements($1::jsonb))`:'$1::jsonb'})`,[payload]);
 };
 await insert('users',Buffer.from(read('stage32-target-rows.json').find(t=>t.table_name==='users').payload_b64,'base64').toString('utf8'));
 for(const p of parents){
  if(p.table_name==='users')p.payload=(await db.query(`SELECT jsonb_agg(value||'{"password_hash":"!DISABLED_REHEARSAL"}'::jsonb)::text p FROM jsonb_array_elements($1::jsonb)`,[p.payload])).rows[0].p;
  else {const t=read('stage33-before-import.json').tables.find(t=>t.table_name===p.table_name);await insert(p.table_name,Buffer.from(t.payload_b64,'base64').toString('utf8'));}
  await insert(p.table_name,p.payload);
 }
 for(const t of read('stage34-baseline-rows.json'))await insert(t.table_name,Buffer.from(t.payload_b64,'base64').toString('utf8'));
 for(const c of fresh.constraints.filter(c=>c.contype==='f'))await db.exec(`ALTER TABLE public.${c.table_name} ADD CONSTRAINT "${c.conname}" ${c.definition}`);
 for(const idx of fresh.indexes)if(!fresh.constraints.some(c=>c.conname===idx.indexname))await db.exec(idx.indexdef);
 for(const [key,name] of [['counter','tozon_internal.customer_pko_counter'],['settings','public.construction_settings']])await db.query(`INSERT INTO ${name} SELECT * FROM jsonb_populate_record(NULL::${name},$1::jsonb)`,[JSON.stringify(before[key])]);
 await db.exec(`INSERT INTO crm_document_settings(id,data) VALUES(1,'{"numbering":{"PKO":"ПКО-{id}","RKO":"РКО-{id}"}}');CREATE FUNCTION tozon_internal.queue_configured_sms(text,text,integer,integer,integer DEFAULT NULL) RETURNS void LANGUAGE sql AS 'INSERT INTO public.sms_events DEFAULT VALUES';`);
 for(const f of before.helpers)await db.exec(f.definition);
 for(const f of fresh.functions)await db.exec(f.definition);
 for(const t of fresh.triggers)await db.exec(t.definition);
 for(const b of new Set(before.import_map.map(r=>r.batch_id)))await db.query(`INSERT INTO tozon_import.batches(id,source_ref) VALUES($1,'yeslzrrcwgcqfxhgbrqk')`,[b]);
 await db.query(`INSERT INTO tozon_import.rows SELECT * FROM jsonb_populate_recordset(NULL::tozon_import.rows,$1::jsonb)`,[JSON.stringify(before.import_map)]);
 const migration=readdirSync('supabase/migrations').find(n=>n.endsWith('_company_project_legacy_cash_import.sql'));await db.exec(readFileSync('supabase/migrations/'+migration,'utf8'));
 await db.exec(sql);
 const imported=(await db.query(`SELECT table_name,count(*)::int rows FROM tozon_import.rows WHERE batch_id=$1 GROUP BY table_name ORDER BY table_name`,[batchId])).rows;
 const actual=(await db.query(`SELECT table_name,currency,coalesce(status,'ACTIVE') status,sum(amount_minor::numeric)::text amount_minor FROM (SELECT 'payments' table_name,currency,status,amount_minor FROM payments WHERE source_import_batch_id=$1 UNION ALL SELECT 'expenses',currency,status,amount_minor FROM expenses WHERE source_import_batch_id=$1 UNION ALL SELECT 'cash_transfers',currency,status,amount_minor FROM cash_transfers WHERE source_import_batch_id=$1) t GROUP BY 1,2,3 ORDER BY 1,2,3`,[batchId])).rows;
 if(JSON.stringify(actual)!==JSON.stringify(totals.rows))throw Error('NUMERIC_TOTAL_DRIFT');
 const groups=(await db.query(`SELECT count(DISTINCT conversion_id)::int conversion_groups,count(*)::int conversion_legs FROM (SELECT conversion_id FROM payments WHERE source_import_batch_id=$1 UNION ALL SELECT conversion_id FROM expenses WHERE source_import_batch_id=$1) t WHERE conversion_id IS NOT NULL`,[batchId])).rows[0];
 if(JSON.stringify(groups)!==JSON.stringify(originalGroups.rows[0]))throw Error('CONVERSION_GROUP_DRIFT');
 const report={batch_id:batchId,snapshot_at:read('source-manifest.json').snapshot_at,rows:imported.reduce((n,t)=>n+t.rows,0),tables:imported,typed_rehearsal:true,exact_numeric_totals:true,...groups,source_anomalies:missing,sql_bytes:Buffer.byteLength(sql)};
 writeFileSync(root+'/stage34-cash-import.sql',sql);writeFileSync(root+'/stage34-cash-batch.json',JSON.stringify(report,null,2)+'\n');writeFileSync(root+'/stage34-source-totals.json',JSON.stringify(totals.rows,null,2)+'\n');console.log(JSON.stringify(report));
}catch(e){console.error(JSON.stringify({message:e.message,code:e.code,table:e.table,constraint:e.constraint}));process.exitCode=1;}finally{await db.close();}
