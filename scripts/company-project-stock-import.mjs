import {TEST_IMPORT_REF} from './company-project-catalog-import.mjs';
export const STOCK_ORDER=['construction_warehouses','construction_materials','construction_documents','construction_stock_entries','construction_settlement_entries','construction_price_corrections','construction_expense_settlement_audit','construction_report_receipts'];
const lit=x=>`'${String(x).replaceAll("'","''")}'`;
const ident=x=>`"${x.replaceAll('"','""')}"`;
const cashRows=`(SELECT 'payments' table_name,r.id::text id,md5(to_jsonb(r)::text) hash FROM public.payments r UNION ALL SELECT 'expenses',r.id::text,md5(to_jsonb(r)::text) FROM public.expenses r)`;
const probes=`jsonb_build_object('sms_events',(SELECT count(*) FROM public.sms_events),'sms_messages',(SELECT count(*) FROM public.sms_messages),'tasks',(SELECT count(*) FROM public.tasks),'notifications',(SELECT count(*) FROM public.user_notifications),'settings',(SELECT to_jsonb(r) FROM public.construction_settings r WHERE id=1),'pko_counter',(SELECT to_jsonb(r) FROM tozon_internal.customer_pko_counter r WHERE id=1))`;
export function stockImportSQL({targetRef,batchId,snapshotAt,tables,baseline,parentMap,cashHashes,sourceSettingsB64}) {
 if(targetRef!==TEST_IMPORT_REF)throw Error('TEST_DESTINATION_REQUIRED');
 if(!/^[0-9a-f-]{36}$/.test(batchId)||!snapshotAt)throw Error('INVALID_BATCH');
 if(tables.length!==STOCK_ORDER.length||new Set(tables.map(t=>t.table_name)).size!==tables.length||tables.some(t=>!STOCK_ORDER.includes(t.table_name)))throw Error('STOCK_TABLE_SET_REQUIRED');
 const base64=x=>typeof x==='string'&&/^[A-Za-z0-9+/=\s]*$/.test(x);
 for(const t of tables)if(t.keys.length!==t.rows||!t.columns.includes(t.pk_column)||!['id','receipt_id'].includes(t.pk_column)||t.columns.some(c=>!/^[a-z_0-9]+$/.test(c)||/password|token|secret|source_import_batch_id/.test(c))||!base64(t.payload_b64))throw Error('INVALID_PAYLOAD_METADATA');
 if(!base64(sourceSettingsB64))throw Error('SOURCE_SETTINGS_REQUIRED');
 let sql=`BEGIN;SET LOCAL TIME ZONE 'UTC';SELECT set_config('tozon.import_batch',${lit(batchId)},true);
 CREATE TEMP TABLE import_stock_payload(table_name text,payload jsonb) ON COMMIT DROP;
 CREATE TEMP TABLE import_stock_keys(table_name text,source_id text,target_id text) ON COMMIT DROP;
 `;
 for(const t of tables){
  sql+=`INSERT INTO import_stock_payload SELECT ${lit(t.table_name)},value FROM jsonb_array_elements(convert_from(decode(${lit(t.payload_b64)},'base64'),'UTF8')::jsonb);\n`;
  sql+=`INSERT INTO import_stock_keys SELECT ${lit(t.table_name)},value->>'source_id',value->>'target_id' FROM jsonb_array_elements(${lit(JSON.stringify(t.keys))}::jsonb);\n`;
 }
 const checkBaseline=tag=>baseline.map(r=>{
  const t=tables.find(t=>t.table_name===r.table_name);if(!t)throw Error('UNEXPECTED_BASELINE_TABLE');
  return `IF NOT EXISTS(SELECT 1 FROM public.${ident(r.table_name)} r WHERE ${ident(t.pk_column)}::text=${lit(r.id)} AND md5((to_jsonb(r)-'source_import_batch_id')::text)=${lit(r.hash)}) THEN RAISE EXCEPTION '${tag}:${r.table_name}';END IF;\n`;
 }).join('');
 sql+=`DO $import$ DECLARE n integer;before_probes jsonb;before_cash jsonb;BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'OWNER_IMPORT_TRANSACTION_REQUIRED';END IF;
 IF EXISTS(SELECT 1 FROM tozon_import.batches WHERE id=${lit(batchId)}::uuid) THEN RAISE EXCEPTION 'BATCH_ALREADY_IMPORTED';END IF;
 before_probes:=${probes};
 SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name,id) INTO before_cash FROM ${cashRows} c;
 IF before_cash IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name,id) FROM jsonb_to_recordset(${lit(JSON.stringify(cashHashes))}::jsonb) c(table_name text,id text,hash text)) THEN RAISE EXCEPTION 'CASH_BASELINE_CHANGED';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_to_recordset(${lit(JSON.stringify(parentMap))}::jsonb) p(table_name text,source_id text,target_id text,payload_hash text) LEFT JOIN tozon_import.rows r USING(table_name,source_id,target_id,payload_hash) WHERE r.batch_id IS NULL) THEN RAISE EXCEPTION 'PARENT_MAPPING_CHANGED';END IF;
 ${checkBaseline('BASELINE_CHANGED')}
 INSERT INTO tozon_import.batches(id,source_ref,snapshot_at,description) VALUES(${lit(batchId)}::uuid,'yeslzrrcwgcqfxhgbrqk',${lit(snapshotAt)}::timestamptz,'Preserved warehouse, construction and settlement history; no new posting');
 INSERT INTO tozon_import.contexts(batch_id,kind,payload) VALUES(${lit(batchId)}::uuid,'source_construction_settings',convert_from(decode(${lit(sourceSettingsB64)},'base64'),'UTF8')::jsonb);
 `;
 for(const name of STOCK_ORDER){
  const t=tables.find(t=>t.table_name===name);
  sql+=`INSERT INTO public.${ident(name)}(${t.columns.map(ident).join(',')},source_import_batch_id) OVERRIDING SYSTEM VALUE SELECT ${t.columns.map(c=>'r.'+ident(c)).join(',')},${lit(batchId)}::uuid FROM jsonb_populate_recordset(NULL::public.${ident(name)},(SELECT coalesce(jsonb_agg(payload),'[]'::jsonb) FROM import_stock_payload WHERE table_name=${lit(name)})) r;\n`;
  sql+=`GET DIAGNOSTICS n=ROW_COUNT;IF n<>${t.rows} THEN RAISE EXCEPTION 'IMPORT_COUNT_MISMATCH:${name}';END IF;\n`;
  const actual=`(SELECT jsonb_object_agg(k,rj->k) FROM unnest(ARRAY[${t.columns.map(lit).join(',')}]) k)`;
  sql+=`IF EXISTS(SELECT 1 FROM import_stock_payload p LEFT JOIN LATERAL (SELECT to_jsonb(r) rj FROM public.${ident(name)} r WHERE r.${ident(t.pk_column)}::text=p.payload->>${lit(t.pk_column)}) d ON true WHERE p.table_name=${lit(name)} AND ${actual} IS DISTINCT FROM p.payload) THEN RAISE EXCEPTION 'IMPORTED_VALUE_DRIFT:${name}';END IF;\n`;
  sql+=`INSERT INTO tozon_import.rows SELECT ${lit(batchId)}::uuid,k.table_name,k.source_id,k.target_id,md5(p.payload::text) FROM import_stock_keys k JOIN import_stock_payload p ON p.table_name=k.table_name AND p.payload->>${lit(t.pk_column)}=k.target_id WHERE k.table_name=${lit(name)};\n`;
 }
 sql+=checkBaseline('DEMO_RECORD_CHANGED');
 sql+=`IF before_cash IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name,id) FROM ${cashRows} c) THEN RAISE EXCEPTION 'CASH_HISTORY_CHANGED';END IF;
 IF before_probes IS DISTINCT FROM ${probes} THEN RAISE EXCEPTION 'IMPORT_SIDE_EFFECT';END IF;END $import$;\n`;
 for(const [table,col] of [['construction_documents','number'],['construction_stock_entries','id'],['construction_settlement_entries','id'],['construction_expense_settlement_audit','id']])sql+=`DO $seq$ DECLARE seq text;n bigint;previous bigint;BEGIN seq:=pg_get_serial_sequence('public.${table}','${col}');IF seq IS NOT NULL THEN SELECT max(${col}) INTO n FROM public.${table};IF n IS NOT NULL THEN EXECUTE format('SELECT last_value FROM %s',seq) INTO previous;PERFORM setval(seq,greatest(n,previous),true);END IF;END IF;END $seq$;\n`;
 return sql+'COMMIT;\n';
}
