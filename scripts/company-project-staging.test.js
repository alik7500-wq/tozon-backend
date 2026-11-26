import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {stageSnapshot,buildSnapshotSQL} from './company-project-staging.mjs';
const table=(table_name,payload)=>({table_name,payload,rows:JSON.parse(payload).length,md5:createHash('md5').update(payload).digest('hex')});
const schema={tables:[
 {table_name:'users',columns:[{name:'id',type:'integer'},{name:'is_active',type:'integer'}]},
 {table_name:'expenses',columns:[{name:'id',type:'uuid'},{name:'created_by',type:'integer'},{name:'conversion_id',type:'uuid'},{name:'amount',type:'numeric'}]},
 {table_name:'payments',columns:[{name:'id',type:'integer'},{name:'created_by',type:'integer'},{name:'conversion_id',type:'uuid'},{name:'amount',type:'numeric'}]},
 ],primary_keys:[{table_name:'users',columns:['id']},{table_name:'expenses',columns:['id']},{table_name:'payments',columns:['id']}],
 foreign_keys:['expenses','payments'].map(child_table=>({name:child_table+'_user_fk',child_table,parent_table:'users',child_columns:['created_by'],parent_columns:['id']}))};
const data=()=>[
 table('users','[{"id":3,"is_active":1,"name":"Synthetic"}]'),
 table('expenses','[{"id":"10000000-0000-4000-8000-000000000001","created_by":3,"conversion_id":"20000000-0000-4000-8000-000000000001","amount":9007199254740993.33,"status":"VOIDED"}]'),
 table('payments','[{"id":3,"created_by":3,"conversion_id":"20000000-0000-4000-8000-000000000001","amount":0.1234567890123456789,"status":"ACTIVE"}]')];
describe('offline PostgreSQL staging',()=>{
 it('exports one statement snapshot using explicit columns without credentials',()=>{
  const sql=buildSnapshotSQL({tables:[{table_name:'users',columns:['id','name','password_hash','access_token','api_key','session_id'].map(name=>({name}))}]});
  expect(sql).toContain('statement_timestamp()');expect(sql).toContain('select "id","name" from public."users"');
  expect(sql).not.toMatch(/password_hash|access_token|api_key|session_id/);
  expect(sql).toContain("md5(payload)");expect(sql).toContain("encode(convert_to(payload,'UTF8'),'base64')");
 });
 it('remaps integer/UUID references while preserving precise money and statuses',async()=>{
  const r=await stageSnapshot(schema,data());
  expect(r.rows).toBe(3);expect(r.fk_constraints).toBe(2);
  expect(r.source_orphans).toEqual([]);expect(r.staging_orphans).toEqual([]);
  expect(r.unchanged_business_fields).toBe(true);expect(r.runtime_ready).toBe(false);
  expect(r.enabled_staged_users).toBe(0);
  expect(r.conversion_groups.map(x=>[x.groups,x.legs])).toEqual([[1,2],[1,2]]);
  expect(r.integrity.find(x=>x.table_name==='users').remapped_columns).toContain('is_active');
 });
 it('reports source orphans without inventing parents or dropping history',async()=>{
  const d=data();d[2]=table('payments',d[2].payload.replace('"created_by":3','"created_by":999'));
  const r=await stageSnapshot(schema,d);
  expect(r.rows).toBe(3);expect(r.source_orphans[0].missing).toBe(1);
  expect(r.staging_orphans[0].missing).toBe(1);expect(r.runtime_ready).toBe(false);
 });
 it('refuses corrupt payloads, credentials and missing tables',async()=>{
  const corrupt=data();corrupt[0].md5='wrong';await expect(stageSnapshot(schema,corrupt)).rejects.toThrow('CHECKSUM_MISMATCH');
  const credential=data();credential[0]=table('users','[{"id":3,"password_hash":"synthetic"}]');
  await expect(stageSnapshot(schema,credential)).rejects.toThrow('CREDENTIALS_IN_EXPORT');
  await expect(stageSnapshot(schema,data().slice(1))).rejects.toThrow('INCOMPLETE_TABLE_SET');
 });
});
