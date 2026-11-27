import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createClosureFixture} from './workspace.closure-fixture.js';
let db,plaza,tower;
const call=(actor=30,project=plaza)=>db.query('SELECT read_company_project_readiness($1,$2) r',[actor,project]).then(r=>r.rows[0].r);
beforeAll(async()=>{
 ({db,plaza,tower}=await createClosureFixture());
 await db.exec("CREATE TABLE storage.buckets(id text PRIMARY KEY,public boolean);CREATE TABLE crm_document_templates(kind text,language text,scope text,active boolean);");
 for(const file of ['20261110204856_company_project_internal_reminders.sql','20261111165153_company_project_readiness_audit.sql'])await db.exec(readFileSync(new URL('../../../supabase/migrations/'+file,import.meta.url),'utf8'));
},30000);
afterAll(()=>db?.close());
it('reports missing settings and real scope issues without rewriting any legacy data',async()=>{
 const before=(await db.query('SELECT jsonb_agg(to_jsonb(d) ORDER BY id) x FROM deals d')).rows[0].x;
 const a=await call();expect(a).toMatchObject({project_id:plaza,director_present:false,complex_count:1,partner_count:0,template_gaps:4,private_bucket:null,deal_scope_issues:1});
 expect(a.members).toHaveLength(1);expect(a.members[0]).toMatchObject({user_id:10,project_only:true});
 expect((await db.query('SELECT jsonb_agg(to_jsonb(d) ORDER BY id) x FROM deals d')).rows[0].x).toEqual(before);
});
it('limits metadata to the requested project and accepts only own or shared active templates',async()=>{
 await db.exec("INSERT INTO crm_document_templates VALUES('CONTRACT','RU','2',true),('SCHEDULE','TJ','*',false)");expect((await call()).template_gaps).toBe(4);expect((await call(30,tower)).template_gaps).toBe(3);
 await db.exec("INSERT INTO crm_document_templates VALUES('CONTRACT','RU','1',true),('SCHEDULE','TJ','*',true)");expect((await call()).template_gaps).toBe(2);
});
it('distinguishes missing and public storage from a private bucket',async()=>{
 await db.exec("INSERT INTO storage.buckets VALUES('company-project-private',true)");expect((await call()).private_bucket).toMatchObject({exists:true,private:false});await db.exec("UPDATE storage.buckets SET public=false");expect((await call()).private_bucket.private).toBe(true);
});
it('requires fresh global admin permissions, rejects a scoped ADMIN and does not enumerate an absent project',async()=>{
 await expect(call(10)).rejects.toThrow('REMINDER_ADMIN_REQUIRED');await expect(call(30,'00000000-0000-4000-8000-000000000099')).rejects.toThrow('PROJECT_NOT_FOUND');await db.exec("UPDATE users SET permissions='[\"access.v2\",\"settings.view\"]' WHERE id=30");await expect(call()).rejects.toThrow('REMINDER_ADMIN_REQUIRED');await db.exec("UPDATE users SET permissions='[]' WHERE id=30");
});
it('does not expose the audit through direct browser-role RPC',async()=>{await db.exec('SET ROLE authenticated');await expect(call()).rejects.toThrow();await db.exec('RESET ROLE');});
