import {PGlite} from '@electric-sql/pglite';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CATALOG_ORDER,TEST_IMPORT_REF} from './company-project-catalog-import.mjs';
import {CUSTOMER_ORDER,customerImportSQL} from './company-project-customer-import.mjs';
const root=resolve(process.argv[2]);
const read=n=>JSON.parse(readFileSync(root+'/'+n));
const schema=read('schema.json'),old=read('target-before-stage32.json'),fresh=read('stage33-target.json');
const before=read('stage33-before-import.json'),manifest=read('source-manifest.json');
const source=new PGlite(root+'/staging-pg');const tables=[];
for(const table_name of CUSTOMER_ORDER){
 const r=await source.query(`SELECT encode(convert_to(coalesce(jsonb_agg(payload ORDER BY ordinal),'[]'::jsonb)::text,'UTF8'),'base64') payload_b64,count(*)::int rows FROM staged_rows WHERE table_name=$1`,[table_name]);
 const k=await source.query('SELECT s.payload->>\'id\' source_id,d.payload->>\'id\' target_id FROM source_rows s JOIN staged_rows d USING(table_name,ordinal) WHERE s.table_name=$1 ORDER BY s.ordinal',[table_name]);
 tables.push({table_name,...r.rows[0],keys:k.rows,columns:schema.tables.find(t=>t.table_name===table_name).columns.map(c=>c.name)});
}
// The current source has no undeclared marketing dictionary links; refuse rather than guess.
if((await source.query("SELECT count(*)::int n FROM source_rows WHERE table_name='marketing_partners' AND payload->>'legacy_dictionary_id' IS NOT NULL")).rows[0].n)throw Error('MARKETING_DICTIONARY_MAPPING_REQUIRED');
await source.close();
const batchId=randomUUID();
const sql=customerImportSQL({targetRef:TEST_IMPORT_REF,batchId,snapshotAt:manifest.snapshot_at,tables,baseline:before.baseline,catalogMap:before.catalog_map});
const db=new PGlite();
const create=async(name,cols)=>{
 const parts=cols.map(c=>{let type=c.data_type==='ARRAY'?'text[]':c.data_type,def=c.column_default;if(def?.startsWith('nextval(')){type=type==='bigint'?'bigserial':'serial';def=null;}return `"${c.column_name}" ${type}${def?' DEFAULT '+def:''}${c.is_nullable==='NO'?' NOT NULL':''}`;});
 await db.exec(`CREATE TABLE public.${name}(${parts.join(',')})`);
};
try{
 await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA tozon_internal;');
 for(const name of [...CATALOG_ORDER,'crm_roles','deals'])await create(name,old.columns.filter(c=>c.table_name===name));
 for(const c of old.constraints.filter(c=>[...CATALOG_ORDER,'crm_roles','deals'].includes(c.table_name)&&c.contype!=='f'))await db.exec(`ALTER TABLE public.${c.table_name} ADD CONSTRAINT "${c.conname}" ${c.definition}`);
 for(const c of old.constraints.filter(c=>[...CATALOG_ORDER,'crm_roles'].includes(c.table_name)&&c.contype==='f'))await db.exec(`ALTER TABLE public.${c.table_name} ADD CONSTRAINT "${c.conname}" ${c.definition}`);
 await db.exec('CREATE TABLE public.leads(id integer PRIMARY KEY);CREATE TABLE public.crm_document_settings(id integer PRIMARY KEY,data jsonb);CREATE TABLE public.company_projects(id uuid PRIMARY KEY);INSERT INTO public.company_projects VALUES(gen_random_uuid());CREATE TABLE public.company_workspace_users(user_id integer PRIMARY KEY REFERENCES users(id),enabled boolean NOT NULL);CREATE TABLE public.expenses(id integer PRIMARY KEY);');
 for(const t of ['sms_events','sms_messages','tasks','user_notifications'])await db.exec(`CREATE TABLE public.${t}(id integer GENERATED ALWAYS AS IDENTITY)`);
 for(const suffix of ['company_project_import_compatibility.sql','company_project_import_parking_area.sql']){const p=readdirSync('supabase/migrations').find(n=>n.endsWith('_'+suffix));await db.exec(readFileSync('supabase/migrations/'+p,'utf8'));}
 const baseline=read('stage32-target-rows.json');
 for(const t of [...baseline.filter(t=>t.table_name==='crm_roles'),...baseline.filter(t=>t.table_name!=='crm_roles')]){
  let p=Buffer.from(t.payload_b64,'base64').toString('utf8');
  if(t.table_name==='users')p=(await db.query(`SELECT jsonb_agg(value||'{"password_hash":"!DEMO_REHEARSAL"}'::jsonb)::text p FROM jsonb_array_elements($1::jsonb)`,[p])).rows[0].p;
  await db.query(`INSERT INTO public.${t.table_name} SELECT * FROM jsonb_populate_recordset(NULL::public.${t.table_name},$1::jsonb)`,[p]);
 }
 await db.exec(readFileSync(root+'/stage32-catalog-import.sql','utf8'));
 await db.exec('DROP TABLE public.leads');
 await create('leads',fresh.columns.filter(c=>c.table_name==='leads'));
 await create('deal_payment_schedules',fresh.columns.filter(c=>c.table_name==='deal_payment_schedules'));
 for(const c of fresh.constraints.filter(c=>['leads','deal_payment_schedules'].includes(c.table_name)&&c.contype!=='f'))await db.exec(`ALTER TABLE public.${c.table_name} ADD CONSTRAINT "${c.conname}" ${c.definition}`);
 for(const c of fresh.constraints.filter(c=>['leads','deals','deal_payment_schedules'].includes(c.table_name)&&c.contype==='f'))await db.exec(`ALTER TABLE public.${c.table_name} ADD CONSTRAINT "${c.conname}" ${c.definition}`);
 // Parent UUIDs are fixture anchors only; no grants or project configuration are inferred.
 const demoDeals=before.tables.find(t=>t.table_name==='deals');
 await db.query(`INSERT INTO company_projects SELECT DISTINCT (value->>'company_project_id')::uuid FROM jsonb_array_elements(convert_from(decode($1,'base64'),'UTF8')::jsonb) WHERE value->>'company_project_id' IS NOT NULL ON CONFLICT DO NOTHING`,[demoDeals.payload_b64]);
 for(const name of ['marketing_partners','leads','deals','deal_payment_schedules']){const t=before.tables.find(t=>t.table_name===name);await db.query(`INSERT INTO public.${name} SELECT * FROM jsonb_populate_recordset(NULL::public.${name},convert_from(decode($1,'base64'),'UTF8')::jsonb)`,[t.payload_b64]);}
 const migration=readdirSync('supabase/migrations').find(n=>n.endsWith('_company_project_legacy_contract_import.sql'));
 await db.exec(readFileSync('supabase/migrations/'+migration,'utf8'));
 await db.exec(`INSERT INTO crm_document_settings(id,data) VALUES(1,'{"numbering":{"CONTRACT":"{id4}"}}');
 CREATE FUNCTION tozon_internal.queue_configured_sms(text,text,integer,integer,integer DEFAULT NULL) RETURNS void LANGUAGE sql AS 'INSERT INTO public.sms_events DEFAULT VALUES';
 CREATE TRIGGER crm_deal_number BEFORE INSERT ON public.deals FOR EACH ROW EXECUTE FUNCTION tozon_internal.assign_document_number();
 CREATE TRIGGER queue_deal_sms AFTER INSERT OR UPDATE ON public.deals FOR EACH ROW EXECUTE FUNCTION tozon_internal.queue_deal_sms();`);
 await db.exec(sql);
 const r=await db.query('SELECT table_name,count(*)::int rows FROM tozon_import.rows WHERE batch_id=$1 GROUP BY table_name ORDER BY table_name',[batchId]);
 const report={batch_id:batchId,snapshot_at:manifest.snapshot_at,rows:r.rows.reduce((n,t)=>n+t.rows,0),tables:r.rows,typed_rehearsal:true};
 if(report.rows!==tables.reduce((n,t)=>n+t.rows,0))throw Error('IMPORT_TOTAL_MISMATCH');
 writeFileSync(root+'/stage33-customer-import.sql',sql);writeFileSync(root+'/stage33-customer-batch.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}catch(e){console.error(JSON.stringify({message:e.message,code:e.code,table:e.table,constraint:e.constraint}));process.exitCode=1;}finally{await db.close();}
