import {PGlite} from '@electric-sql/pglite';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CATALOG_ORDER,catalogImportSQL,TEST_IMPORT_REF} from './company-project-catalog-import.mjs';

const root=resolve(process.argv[2]);
const schema=JSON.parse(readFileSync(root+'/schema.json'));
const target=JSON.parse(readFileSync(root+'/target-before-stage32.json'));
const before=JSON.parse(readFileSync(root+'/stage32-before-import.json'));
const baselineRows=JSON.parse(readFileSync(root+'/stage32-target-rows.json'));
const manifest=JSON.parse(readFileSync(root+'/source-manifest.json'));
const source=new PGlite(root+'/staging-pg');
const tables=[];
for(const table_name of CATALOG_ORDER) {
 const r=await source.query(`SELECT encode(convert_to(coalesce(jsonb_agg(CASE WHEN s.table_name='users' THEN jsonb_set(s.payload,'{permissions}','["company.project-only"]'::jsonb) ELSE s.payload END ORDER BY s.ordinal),'[]'::jsonb)::text,'UTF8'),'base64') payload_b64,count(*)::int rows FROM staged_rows s WHERE table_name=$1`,[table_name]);
 const keys=await source.query(`SELECT s.payload->>'id' source_id,d.payload->>'id' target_id FROM source_rows s JOIN staged_rows d USING(table_name,ordinal) WHERE s.table_name=$1 ORDER BY s.ordinal`,[table_name]);
 tables.push({table_name,...r.rows[0],keys:keys.rows,columns:schema.tables.find(t=>t.table_name===table_name).columns.filter(c=>c.name!=='password_hash').map(c=>c.name)});
}
const roleRows=await source.query(`SELECT encode(convert_to(jsonb_agg(payload)::text,'UTF8'),'base64') b64 FROM source_rows WHERE table_name='crm_roles'`);
await source.close();
const batchId=randomUUID();
const sql=catalogImportSQL({targetRef:TEST_IMPORT_REF,batchId,snapshotAt:manifest.snapshot_at,tables,baseline:before.baseline,rolesB64:roleRows.rows[0].b64});
const db=new PGlite();
try {
 await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;');
 for(const name of [...CATALOG_ORDER,'crm_roles','deals']) {
  const cols=target.columns.filter(c=>c.table_name===name).map(c=>{
   let type=c.data_type==='ARRAY'?'text[]':c.data_type,def=c.column_default;
   if(def?.startsWith('nextval(')){type=type==='bigint'?'bigserial':'serial';def=null;}
   return `"${c.column_name}" ${type}${def?' DEFAULT '+def:''}${c.is_nullable==='NO'?' NOT NULL':''}`;
  });
  await db.exec(`CREATE TABLE public.${name}(${cols.join(',')})`);
 }
 for(const c of target.constraints.filter(c=>[...CATALOG_ORDER,'crm_roles','deals'].includes(c.table_name)&&c.contype!=='f'))await db.exec(`ALTER TABLE public.${c.table_name} ADD CONSTRAINT "${c.conname}" ${c.definition}`);
 for(const c of target.constraints.filter(c=>[...CATALOG_ORDER,'crm_roles'].includes(c.table_name)&&c.contype==='f'))await db.exec(`ALTER TABLE public.${c.table_name} ADD CONSTRAINT "${c.conname}" ${c.definition}`);
 await db.exec('CREATE TABLE public.leads(id integer PRIMARY KEY);CREATE TABLE public.crm_document_settings(id integer PRIMARY KEY);CREATE TABLE public.company_projects(id uuid);INSERT INTO public.company_projects VALUES(gen_random_uuid());CREATE TABLE public.company_workspace_users(user_id integer PRIMARY KEY REFERENCES users(id),enabled boolean NOT NULL);');
 for(const t of ['sms_events','sms_messages','tasks','user_notifications'])await db.exec(`CREATE TABLE public.${t}(id integer)`);
 await db.exec(readFileSync('supabase/migrations/20261126190623_company_project_import_compatibility.sql','utf8'));
 const parkingMigration=readdirSync('supabase/migrations').find(n=>n.endsWith('_company_project_import_parking_area.sql'));
 await db.exec(readFileSync('supabase/migrations/'+parkingMigration,'utf8'));
 for(const t of [...baselineRows.filter(t=>t.table_name==='crm_roles'),...baselineRows.filter(t=>t.table_name!=='crm_roles')]) {
  let payload=Buffer.from(t.payload_b64,'base64').toString('utf8');
  if(t.table_name==='users') {
   const r=await db.query(`SELECT coalesce(jsonb_agg(value||'{"password_hash":"!DEMO_REHEARSAL"}'::jsonb),'[]'::jsonb)::text payload FROM jsonb_array_elements($1::jsonb)`,[payload]);payload=r.rows[0].payload;
  }
  await db.query(`INSERT INTO public.${t.table_name} SELECT * FROM jsonb_populate_recordset(NULL::public.${t.table_name},$1::jsonb)`,[payload]);
 }
 await db.exec(sql);
 const r=await db.query('SELECT table_name,count(*)::int rows FROM tozon_import.rows GROUP BY table_name ORDER BY table_name');
 const expected=tables.reduce((n,t)=>n+t.rows,0),actual=r.rows.reduce((n,t)=>n+t.rows,0);
 if(actual!==expected)throw Error('IMPORT_TOTAL_MISMATCH');
 writeFileSync(root+'/stage32-catalog-import.sql',sql);
 writeFileSync(root+'/stage32-catalog-batch.json',JSON.stringify({batch_id:batchId,snapshot_at:manifest.snapshot_at,rows:actual,tables:r.rows},null,2)+'\n');
 console.log(JSON.stringify({batch_id:batchId,rows:actual,tables:r.rows,typed_rehearsal:true}));
}catch(e){console.error(JSON.stringify({message:e.message,code:e.code,table:e.table,constraint:e.constraint}));process.exitCode=1;}finally{await db.close();}
