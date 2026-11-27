export const TEST_IMPORT_REF='yaolkwbnhnacxxjpgiyu';
export const CATALOG_ORDER=['users','projects','buildings','sections','floors','layout_types','layout_rooms','layout_features','units','discount_schemes'];
const lit=s=>`'${String(s).replaceAll("'","''")}'`;
const ident=s=>`"${String(s).replaceAll('"','""')}"`;
const background=`jsonb_build_object('sms_events',(SELECT count(*) FROM public.sms_events),'sms_messages',(SELECT count(*) FROM public.sms_messages),'tasks',(SELECT count(*) FROM public.tasks),'notifications',(SELECT count(*) FROM public.user_notifications))`;

// Produces a catalog-only transaction. Never accepts a production destination.
// Caller obtains payloads as base64 PostgreSQL JSON text, avoiding numeric coercion.
export function catalogImportSQL({targetRef,batchId,snapshotAt,tables,baseline,rolesB64}) {
 if(targetRef!==TEST_IMPORT_REF)throw Error('TEST_DESTINATION_REQUIRED');
 if(!/^[0-9a-f-]{36}$/.test(batchId)||!snapshotAt)throw Error('INVALID_BATCH');
 if(!rolesB64||!/^[A-Za-z0-9+/=\s]+$/.test(rolesB64))throw Error('ROLE_SNAPSHOT_REQUIRED');
 if(tables.length!==CATALOG_ORDER.length||new Set(tables.map(t=>t.table_name)).size!==tables.length||tables.some(t=>!CATALOG_ORDER.includes(t.table_name)))throw Error('CATALOG_TABLE_SET_REQUIRED');
 for(const t of tables) {
  if(!/^[A-Za-z0-9+/=\s]*$/.test(t.payload_b64)||t.columns.some(c=>/password|token|secret/i.test(c))||t.columns.some(c=>!/^[a-z_0-9]+$/.test(c)))throw Error('UNSAFE_PAYLOAD_METADATA');
  if(t.rows!==t.keys.length)throw Error('IDENTITY_COUNT_MISMATCH');
 }
 let sql=`BEGIN;\nSET LOCAL TIME ZONE 'UTC';\nCREATE TEMP TABLE import_catalog_payload(table_name text,payload jsonb) ON COMMIT DROP;\nCREATE TEMP TABLE import_catalog_keys(table_name text,source_id text,target_id text) ON COMMIT DROP;\n`;
 for(const t of tables) {
  sql+=`INSERT INTO import_catalog_payload SELECT ${lit(t.table_name)},value FROM jsonb_array_elements(convert_from(decode(${lit(t.payload_b64)},'base64'),'UTF8')::jsonb);\n`;
  for(const k of t.keys)sql+=`INSERT INTO import_catalog_keys VALUES(${lit(t.table_name)},${lit(k.source_id)},${lit(k.target_id)});\n`;
 }
 sql+=`DO $import$ DECLARE n integer;before_background jsonb;BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.company_projects) THEN RAISE EXCEPTION 'PILOT_DATABASE_REQUIRED';END IF;
 IF EXISTS(SELECT 1 FROM tozon_import.batches WHERE id=${lit(batchId)}::uuid) THEN RAISE EXCEPTION 'BATCH_ALREADY_IMPORTED';END IF;
 before_background:=${background};
`;
 for(const r of baseline) {
  if(!CATALOG_ORDER.includes(r.table_name))throw Error('UNEXPECTED_BASELINE_TABLE');
  sql+=`IF NOT EXISTS(SELECT 1 FROM public.${ident(r.table_name)} r WHERE id::text=${lit(r.id)} AND md5((to_jsonb(r)-'password_hash')::text)=${lit(r.hash)}) THEN RAISE EXCEPTION 'BASELINE_CHANGED:${r.table_name}';END IF;\n`;
 }
 sql+=`INSERT INTO tozon_import.batches(id,source_ref,snapshot_at,description) VALUES(${lit(batchId)}::uuid,'yeslzrrcwgcqfxhgbrqk',${lit(snapshotAt)}::timestamptz,'Catalog and disabled identities only; financial import pending');\n`;
 sql+=`INSERT INTO public.crm_roles SELECT r.* FROM jsonb_populate_recordset(NULL::public.crm_roles,(SELECT jsonb_agg(value||'{"is_active":false}'::jsonb) FROM jsonb_array_elements(convert_from(decode(${lit(rolesB64)},'base64'),'UTF8')::jsonb))) r ON CONFLICT(code) DO NOTHING;\n`;
 for(const name of CATALOG_ORDER) {
  const t=tables.find(t=>t.table_name===name),cols=t.columns.map(ident).join(',');
  if(name==='users')sql+=`IF EXISTS(SELECT 1 FROM import_catalog_payload WHERE table_name='users' AND (payload->>'is_active'<>'0' OR payload->'permissions'<>'["company.project-only"]'::jsonb)) THEN RAISE EXCEPTION 'SOURCE_USERS_MUST_BE_DISABLED_AND_SCOPED';END IF;\n`;
  sql+=`INSERT INTO public.${ident(name)}(${cols}${name==='users'?',password_hash':''}) SELECT ${t.columns.map(c=>'r.'+ident(c)).join(',')}${name==='users'?",'!DISABLED_SOURCE_IMPORT'":''} FROM jsonb_populate_recordset(NULL::public.${ident(name)},(SELECT coalesce(jsonb_agg(payload),'[]'::jsonb) FROM import_catalog_payload WHERE table_name=${lit(name)})) r;\n`;
  sql+=`GET DIAGNOSTICS n=ROW_COUNT;IF n<>${t.rows} THEN RAISE EXCEPTION 'IMPORT_COUNT_MISMATCH:${name}';END IF;\n`;
  const actual=`(SELECT jsonb_object_agg(k,rj->k) FROM unnest(ARRAY[${t.columns.map(lit).join(',')}]) k)`;
  sql+=`IF EXISTS(SELECT 1 FROM import_catalog_payload p JOIN LATERAL (SELECT to_jsonb(r) rj FROM public.${ident(name)} r WHERE r.id::text=p.payload->>'id') d ON true WHERE p.table_name=${lit(name)} AND ${actual} IS DISTINCT FROM p.payload) THEN RAISE EXCEPTION 'IMPORTED_VALUE_DRIFT:${name}';END IF;\n`;
  sql+=`INSERT INTO tozon_import.rows SELECT ${lit(batchId)}::uuid,k.table_name,k.source_id,k.target_id,md5(p.payload::text) FROM import_catalog_keys k JOIN import_catalog_payload p ON p.table_name=k.table_name AND p.payload->>'id'=k.target_id WHERE k.table_name=${lit(name)};\n`;
 }
 sql+=`INSERT INTO public.company_workspace_users(user_id,enabled) SELECT (payload->>'id')::integer,false FROM import_catalog_payload WHERE table_name='users';\n`;
 for(const r of baseline)sql+=`IF NOT EXISTS(SELECT 1 FROM public.${ident(r.table_name)} r WHERE id::text=${lit(r.id)} AND md5((to_jsonb(r)-'password_hash')::text)=${lit(r.hash)}) THEN RAISE EXCEPTION 'DEMO_RECORD_CHANGED:${r.table_name}';END IF;\n`;
 sql+=`IF before_background IS DISTINCT FROM ${background} THEN RAISE EXCEPTION 'IMPORT_BACKGROUND_SIDE_EFFECT';END IF;\nEND $import$;\n`;
 for(const name of CATALOG_ORDER)sql+=`DO $seq$ DECLARE seq text;n bigint;BEGIN seq:=pg_get_serial_sequence('public.${name}','id');IF seq IS NOT NULL THEN SELECT max(id) INTO n FROM public.${ident(name)};PERFORM setval(seq,n,true);END IF;END $seq$;\n`;
 return sql+'COMMIT;\n';
}
