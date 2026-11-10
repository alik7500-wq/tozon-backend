import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createWriteFixture} from './workspace.write-fixture.js';
import {randomUUID} from 'node:crypto';
let db,plaza,tower;
const query=(name,args)=>db.query(`SELECT ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS result`,args).then(r=>r.rows[0].result);
const doc=(actor=10,project=plaza,deal=1)=>query('read_company_project_document',[actor,project,deal]);
const file=(id,actor=10,project=plaza,deal=1)=>query('read_company_project_files',[actor,project,deal,id]);
const register=(id,actor=10,project=plaza,deal=1,hash='a'.repeat(64))=>query('register_company_project_file',[actor,project,deal,id,'contract.pdf','application/pdf',100,hash]);
beforeAll(async()=>{
 ({db,plaza,tower}=await createWriteFixture());
 await db.exec('CREATE SCHEMA storage;CREATE TABLE storage.objects(id uuid,bucket_id text);ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;');
 await db.exec(readFileSync(new URL('../../../supabase/migrations/20261110160426_company_project_documents_private_files.sql',import.meta.url),'utf8'));
 await db.query("UPDATE deals SET company_project_id=$1,company_director_snapshot='{\"company_name\":\"TOZON\",\"director_name\":\"Signing director\",\"director_authority\":\"Authority\"}' WHERE id=1",[plaza]);
 await db.query('UPDATE deals SET company_project_id=$1 WHERE id=2',[tower]);
 await db.exec("UPDATE company_workspace_access SET sections=array_append(sections,'documents.print'),write_sections=array_append(write_sections,'documents.manage')");
},30000);
afterAll(()=>db?.close());
describe.sequential('private project document boundary in SQL',()=>{
 it('returns canonical own data and the frozen signing director without public paths',async()=>{
  const d=await doc();expect(d.client.passport_number).toBe('PRIVATE-A');expect(d.signer.director_name).toBe('Signing director');expect(JSON.stringify(d)).not.toContain('PRIVATE-B');
  await db.query("UPDATE company_projects SET director_name='New director' WHERE id=$1",[plaza]);expect((await doc()).signer.director_name).toBe('Signing director');
 });
 it('requires a document grant in addition to ordinary contract read access',async()=>{
  await db.exec("UPDATE company_workspace_access SET sections=array_remove(sections,'documents.print') WHERE user_id=10");
  await expect(doc()).rejects.toThrow('WORKSPACE_DOCUMENT_DENIED');await db.exec("UPDATE company_workspace_access SET sections=array_append(sections,'documents.print') WHERE user_id=10");
 });
 it('rejects foreign project, foreign contract IDs, mixed-client and legacy unassigned contracts',async()=>{
  await expect(doc(10,tower,2)).rejects.toThrow();await expect(doc(10,plaza,2)).rejects.toThrow();await expect(doc(10,plaza,3)).rejects.toThrow();
  await db.exec("INSERT INTO deals(id,unit_id,lead_id,contract_number,status,currency,final_price_minor,down_payment_minor,deal_date) VALUES(50,1,1,'Legacy','SIGNED','USD',10000,0,'2026-11-10')");await expect(doc(10,plaza,50)).rejects.toThrow('SCOPED_DOCUMENT_REQUIRED');
 });
 it('does not return the payment graph without financial read permission',async()=>{
  await db.exec("UPDATE company_workspace_access SET sections=array_remove(sections,'finance.payments') WHERE user_id=10");const d=await doc();expect(d.financial).toBe(false);expect(d.schedules).toEqual([]);
  await db.exec("UPDATE company_workspace_access SET sections=array_append(sections,'finance.payments') WHERE user_id=10");
 });
 it('uses historical TJS conversion in document totals and refuses a foreign cash source',async()=>{
  await db.exec("UPDATE payments SET amount_minor=92400,currency='TJS',exchange_rate=9.24,amount_usd=100 WHERE id=1");expect((await doc()).total_paid_minor).toBe(10000);
  await db.exec("UPDATE payments SET cash_desk_id='00000000-0000-4000-8000-000000000002' WHERE id=1");await expect(doc()).rejects.toThrow('DOCUMENT_PAYMENT_SCOPE_MISMATCH');
  await db.exec("UPDATE payments SET cash_desk_id='00000000-0000-4000-8000-000000000001',amount_minor=100,currency='USD',amount_usd=NULL,exchange_rate=NULL WHERE id=1");
 });
 it('registers a file idempotently, derives its path and hides paths from the catalog',async()=>{
  const id=randomUUID(),first=await register(id);expect(await register(id)).toEqual(first);expect(first.object_path).toBeUndefined();
  expect((await file(id)).object_path).toBe(`${plaza}/1/${id}`);
  const list=await query('read_company_project_files',[10,plaza,1]);expect(list.records.some(x=>x.id===id)).toBe(true);expect(list.records[0].object_path).toBeUndefined();
  await expect(register(id,10,plaza,1,'b'.repeat(64))).rejects.toThrow('FILE_REQUEST_REUSED');
  await expect(file(id,20,tower,2)).rejects.toThrow('FILE_NOT_FOUND');
 });
 it('rejects attachment writes after permission revocation and forged direct project links',async()=>{
  await db.exec("UPDATE company_workspace_access SET write_sections=array_remove(write_sections,'documents.manage') WHERE user_id=10");await expect(register(randomUUID())).rejects.toThrow('WORKSPACE_DOCUMENT_DENIED');
  await db.exec("UPDATE company_workspace_access SET write_sections=array_append(write_sections,'documents.manage') WHERE user_id=10");await expect(register(randomUUID(),10,plaza,2)).rejects.toThrow();
 });
 it('blocks browser roles from the file catalog and storage bucket even with a broad permissive policy',async()=>{
  await db.exec("GRANT USAGE ON SCHEMA storage TO authenticated;GRANT SELECT ON storage.objects TO authenticated;CREATE POLICY test_broad_storage ON storage.objects FOR SELECT TO authenticated USING(true);INSERT INTO storage.objects VALUES(gen_random_uuid(),'company-project-private'),(gen_random_uuid(),'another-bucket');SET ROLE authenticated;");
  expect((await db.query('SELECT bucket_id FROM storage.objects')).rows).toEqual([{bucket_id:'another-bucket'}]);
  await expect(db.query('SELECT * FROM company_project_files')).rejects.toThrow();await expect(doc()).rejects.toThrow();await db.exec('RESET ROLE');
 });
});
