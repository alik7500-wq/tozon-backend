import {PGlite} from '@electric-sql/pglite';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const literal=s=>`'${String(s).replaceAll("'","''")}'`;
const hasValue=(alias,col)=>`${alias}.payload->${literal(col)} IS NOT NULL AND ${alias}.payload->${literal(col)}<>'null'::jsonb`;
const equality=fk=>fk.child_columns.map((c,i)=>`c.payload->${literal(c)}=p.payload->${literal(fk.parent_columns[i])}`).join(' AND ');
const digest=s=>createHash('md5').update(s).digest('hex');

export function buildSnapshotSQL(schema) {
 const ident=s=>`"${String(s).replaceAll('"','""')}"`;
 if(!schema?.tables?.length)throw Error('EMPTY_SCHEMA');
 const arms=schema.tables.map(t=>{
  const columns=t.columns.filter(c=>!/password|token|secret|session|api_key/i.test(c.name)).map(c=>ident(c.name));
  if(!columns.length)throw Error('NO_EXPORTABLE_COLUMNS');
  return `select ${literal(t.table_name)} table_name,count(*) rows,coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),'[]'::jsonb)::text payload from (select ${columns.join(',')} from public.${ident(t.table_name)}) r`;
 });
 return `select jsonb_build_object('snapshot_at',statement_timestamp(),'tables',(select jsonb_agg(jsonb_build_object('table_name',table_name,'rows',rows,'md5',md5(payload),'payload_b64',encode(convert_to(payload,'UTF8'),'base64')) order by table_name) from (${arms.join(' union all ')}) x)) export_snapshot;`;
}

// Only an offline PostgreSQL staging store. No Supabase credentials or API calls.
// Payloads stay in PostgreSQL JSONB: JS never parses monetary numeric values.
export async function stageSnapshot(schema,tables,{directory}={}) {
 const db=new PGlite(directory);
 try {
  const known=new Set(schema.tables.map(t=>t.table_name));
  if(tables.length!==known.size||tables.some(t=>!known.has(t.table_name))||new Set(tables.map(t=>t.table_name)).size!==tables.length)throw Error('INCOMPLETE_TABLE_SET');
  await db.exec(`CREATE TABLE source_rows(table_name text,ordinal bigint,payload jsonb,PRIMARY KEY(table_name,ordinal));
   CREATE TABLE staged_rows(LIKE source_rows INCLUDING ALL);`);
  for(const t of tables) {
   if(digest(t.payload)!==t.md5)throw Error('CHECKSUM_MISMATCH:'+t.table_name);
   const n=await db.query('SELECT jsonb_array_length($1::jsonb) n',[t.payload]);
   if(n.rows[0].n!==t.rows)throw Error('ROW_COUNT_MISMATCH:'+t.table_name);
   if(t.table_name==='users') {
    const r=await db.query(`SELECT count(*)::int n FROM jsonb_array_elements($1::jsonb) r WHERE r ?| array['password_hash','password','access_token']`,[t.payload]);
    if(r.rows[0].n)throw Error('CREDENTIALS_IN_EXPORT');
   }
   await db.query('INSERT INTO source_rows SELECT $1,ordinality,value FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY',[t.table_name,t.payload]);
  }
  await db.exec('INSERT INTO staged_rows SELECT * FROM source_rows');
  const allowed=new Map(schema.tables.map(t=>[t.table_name,new Set()]));
  for(const pk of schema.primary_keys||[]) {
   if(pk.columns.length!==1)continue;
   const col=pk.columns[0],t=schema.tables.find(t=>t.table_name===pk.table_name);
   const type=t.columns.find(c=>c.name===col)?.type;
   if((schema.foreign_keys||[]).some(f=>f.child_table===pk.table_name&&f.child_columns.includes(col)))continue;
   if(!['integer','bigint','smallint','uuid'].includes(type))continue;
   allowed.get(pk.table_name).add(col);
   // Values belong to this offline dataset; they are never allocated application IDs.
   const val=type==='uuid'?`to_jsonb(md5('TOZON_STAGE31|'||table_name||'|'||(payload->>${literal(col)}))::uuid)`:`to_jsonb(1000000::bigint+ordinal)`;
   await db.query(`UPDATE staged_rows SET payload=jsonb_set(payload,ARRAY[${literal(col)}],${val}) WHERE table_name=$1`,[pk.table_name]);
  }
  const orphanChecks=[];
  for(const fk of schema.foreign_keys||[]) {
   if(!known.has(fk.parent_table))throw Error('MISSING_PARENT_TABLE:'+fk.parent_table);
   const q=`SELECT count(*)::int n FROM source_rows c WHERE c.table_name=$1 AND ${fk.child_columns.map(c=>hasValue('c',c)).join(' AND ')} AND NOT EXISTS(SELECT 1 FROM source_rows p WHERE p.table_name=$2 AND ${equality(fk)})`;
   const r=await db.query(q,[fk.child_table,fk.parent_table]);
   orphanChecks.push({constraint:fk.name,child_table:fk.child_table,parent_table:fk.parent_table,missing:r.rows[0].n});
   for(const c of fk.child_columns)allowed.get(fk.child_table).add(c);
  }
  let passes=0,converged=false;
  for(;passes<=schema.tables.length;passes++) {
   let changes=0;
   for(const fk of schema.foreign_keys||[]) {
    let replacement='s.payload';
    for(let i=0;i<fk.child_columns.length;i++)replacement=`jsonb_set(${replacement},ARRAY[${literal(fk.child_columns[i])}],sp.payload->${literal(fk.parent_columns[i])})`;
    const q=`UPDATE staged_rows s SET payload=${replacement} FROM source_rows c,source_rows p,staged_rows sp WHERE s.table_name=$1 AND c.table_name=s.table_name AND c.ordinal=s.ordinal AND p.table_name=$2 AND sp.table_name=p.table_name AND sp.ordinal=p.ordinal AND ${fk.child_columns.map(c=>hasValue('c',c)).join(' AND ')} AND ${equality(fk)} AND s.payload IS DISTINCT FROM ${replacement}`;
    const r=await db.query(q,[fk.child_table,fk.parent_table]);changes+=r.affectedRows||0;
   }
   if(changes===0){converged=true;break;}
  }
  if(!converged)throw Error('FK_REMAP_DID_NOT_CONVERGE');
  // Legacy conversion UUIDs have no master-table FK; map both legs consistently.
  for(const table of ['payments','expenses'])if(known.has(table)) {
   const meta=schema.tables.find(t=>t.table_name===table);
   if(meta.columns.some(c=>c.name==='conversion_id')) {
    allowed.get(table).add('conversion_id');
    await db.query(`UPDATE staged_rows SET payload=jsonb_set(payload,'{conversion_id}',to_jsonb(md5('TOZON_STAGE31|conversion|'||(payload->>'conversion_id'))::uuid)) WHERE table_name=$1 AND payload->>'conversion_id' IS NOT NULL`,[table]);
   }
  }
  if(known.has('users')) {
   allowed.get('users').add('is_active');
   await db.exec(`UPDATE staged_rows SET payload=jsonb_set(payload,'{is_active}','0'::jsonb) WHERE table_name='users'`);
  }
  const integrity=[];
  for(const t of schema.tables) {
   const cols=[...allowed.get(t.table_name)];
   const r=await db.query(`SELECT count(*)::int rows,count(*) FILTER(WHERE (s.payload-$2::text[]) IS DISTINCT FROM (d.payload-$2::text[]))::int non_reference_changes FROM source_rows s JOIN staged_rows d USING(table_name,ordinal) WHERE s.table_name=$1`,[t.table_name,cols]);
   integrity.push({table_name:t.table_name,...r.rows[0],remapped_columns:cols});
  }
  const stagedOrphans=[];
  for(const fk of schema.foreign_keys||[]) {
   const r=await db.query(`SELECT count(*)::int n FROM staged_rows c WHERE c.table_name=$1 AND ${fk.child_columns.map(c=>hasValue('c',c)).join(' AND ')} AND NOT EXISTS(SELECT 1 FROM staged_rows p WHERE p.table_name=$2 AND ${equality(fk)})`,[fk.child_table,fk.parent_table]);
   stagedOrphans.push({constraint:fk.name,missing:r.rows[0].n});
  }
  const row=await db.query('SELECT count(*)::int n FROM staged_rows');
  const conversionGroups=await db.query(`WITH groups AS (
   SELECT 'source' side,payload->>'conversion_id' id,count(*) n FROM source_rows WHERE table_name IN ('payments','expenses') AND payload->>'conversion_id' IS NOT NULL GROUP BY payload->>'conversion_id'
   UNION ALL SELECT 'staged',payload->>'conversion_id',count(*) FROM staged_rows WHERE table_name IN ('payments','expenses') AND payload->>'conversion_id' IS NOT NULL GROUP BY payload->>'conversion_id')
   SELECT side,count(*)::int groups,sum(n)::int legs FROM groups GROUP BY side ORDER BY side`);
  const enabledUsers=await db.query(`SELECT count(*)::int n FROM staged_rows WHERE table_name='users' AND payload->>'is_active'<>'0'`);
  if(enabledUsers.rows[0].n!==0)throw Error('STAGED_USER_ENABLED');
  if(conversionGroups.rows.length&&
   (conversionGroups.rows.length!==2||conversionGroups.rows[0].groups!==conversionGroups.rows[1].groups||conversionGroups.rows[0].legs!==conversionGroups.rows[1].legs))throw Error('CONVERSION_GROUP_DRIFT');
  const report={mode:'OFFLINE_JSONB_STAGING',application_imported:false,rows:row.rows[0].n,tables:tables.length,
   fk_constraints:orphanChecks.length,fk_remap_passes:passes+1,
   source_orphans:orphanChecks.filter(x=>x.missing),staging_orphans:stagedOrphans.filter(x=>x.missing),
   unchanged_business_fields:integrity.every(t=>t.non_reference_changes===0),integrity,
   conversion_groups:conversionGroups.rows,enabled_staged_users:enabledUsers.rows[0].n,
   runtime_ready:false,
   pending:['Undeclared references and IDs nested in immutable audit JSON remain source references.','No application business tables populated.','No external storage files downloaded.','No staff access enabled.']};
  await db.exec(`CREATE TABLE staging_identity_map AS SELECT s.table_name,s.ordinal,s.payload->'id' source_id,d.payload->'id' staged_id FROM source_rows s JOIN staged_rows d USING(table_name,ordinal) WHERE s.payload ? 'id';`);
  if(directory) {
   const rows=await db.query('SELECT table_name,ordinal::text,payload::text FROM staged_rows ORDER BY table_name,ordinal');
   writeFileSync(resolve(directory,'../staged-rows.jsonl'),rows.rows.map(r=>JSON.stringify({table_name:r.table_name,ordinal:r.ordinal}) .slice(0,-1)+',"payload":'+r.payload+'}').join('\n')+'\n');
   const maps=await db.query('SELECT table_name,ordinal::text,source_id::text,staged_id::text FROM staging_identity_map ORDER BY table_name,ordinal');
   writeFileSync(resolve(directory,'../identity-map.json'),JSON.stringify(maps.rows,null,2)+'\n');
  }
  return report;
 } finally {await db.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 const root=resolve(process.argv[2]||'');
 if(!process.argv[2]||!existsSync(resolve(root,'source-manifest.json')))throw Error('Usage: node scripts/company-project-staging.mjs PRIVATE_EXPORT_DIRECTORY');
 const schema=JSON.parse(readFileSync(resolve(root,'schema.json'),'utf8'));
 const manifest=JSON.parse(readFileSync(resolve(root,'source-manifest.json'),'utf8'));
 const directory=resolve(root,'staging-pg');if(existsSync(directory))throw Error('STAGING_DIRECTORY_ALREADY_EXISTS');
 const tables=manifest.tables.map(t=>({...t,payload:Buffer.from(readFileSync(resolve(root,'source',t.table_name+'.b64'),'utf8'),'base64').toString('utf8')}));
 const report=await stageSnapshot(schema,tables,{directory});
 writeFileSync(resolve(root,'staging-report.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({tables:report.tables,rows:report.rows,fk_constraints:report.fk_constraints,source_orphans:report.source_orphans,staging_orphans:report.staging_orphans,unchanged_business_fields:report.unchanged_business_fields,runtime_ready:report.runtime_ready}));
}
