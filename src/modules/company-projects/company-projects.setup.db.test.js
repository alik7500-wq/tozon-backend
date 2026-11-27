import {beforeAll,afterAll,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createClosureFixture} from './workspace.closure-fixture.js';
let db,plaza,tower,created;
const rpc=(name,args)=>db.query(`SELECT ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args).then(r=>r.rows[0].r);
const call=(kind,payload,request=crypto.randomUUID(),actor=30,project=plaza)=>rpc('execute_company_project_admin',[actor,project,request,kind,payload]);
const setup=(actor=30,project=plaza)=>rpc('read_company_project_setup',[actor,project]);
const hash='$2b$12$'+'a'.repeat(53);
beforeAll(async()=>{
 ({db,plaza,tower}=await createClosureFixture());
 await db.exec("ALTER TABLE users ADD COLUMN name text DEFAULT 'Fixture';ALTER TABLE users ADD COLUMN email text UNIQUE;ALTER TABLE users ADD COLUMN password_hash text;ALTER TABLE users ADD COLUMN created_at text;ALTER TABLE users ADD COLUMN updated_at text;CREATE TABLE cash_transfers(id uuid,source_cash_desk_id uuid);CREATE TABLE storage.buckets(id text,public boolean);CREATE TABLE crm_document_templates(kind text,language text,scope text,active boolean);");
 for(const f of ['20261110204856_company_project_internal_reminders.sql','20261111165153_company_project_readiness_audit.sql','20261111180927_company_project_admin_setup.sql','20261111182317_company_project_setup_archived_preview.sql'])await db.exec(readFileSync(new URL('../../../supabase/migrations/'+f,import.meta.url),'utf8'));
},30000);
afterAll(()=>db?.close());
it('requires a current company admin and never returns credentials',async()=>{await expect(setup(10)).rejects.toThrow('REMINDER_ADMIN_REQUIRED');expect(JSON.stringify(await setup())).not.toMatch(/password|fingerprint/);});
it('creates a dedicated account disabled by default, retries same intent and rejects collisions',async()=>{
 const payload={project_revision:1,name:'Pilot member',email:'pilot@example.invalid',password_hash:hash,password_fingerprint:'a'.repeat(64),project_role:'MANAGER'},request=crypto.randomUUID();
 created=await call('CREATE_ACCOUNT',payload,request);expect(created).toMatchObject({enabled:false});expect((await call('CREATE_ACCOUNT',{...payload,password_hash:'$2b$12$'+'b'.repeat(53)},request)).idempotent).toBe(true);
 await expect(call('CREATE_ACCOUNT',{...payload,password_fingerprint:'b'.repeat(64)},request)).rejects.toThrow('ADMIN_REQUEST_REUSED');
 expect((await db.query('SELECT permissions FROM users WHERE id=$1',[created.id])).rows[0].permissions).toEqual(['company.project-only']);expect((await setup()).members.find(m=>m.id===created.id)).toMatchObject({enabled:false,revision:1,sections:[]});
 expect((await db.query('SELECT payload FROM company_project_admin_commands WHERE request_id=$1',[request])).rows[0].payload.password_hash).toBeUndefined();
});
it('will not scope a global admin, checks read/write dependencies and stale versions',async()=>{
 const body={project_revision:2,user_id:created.id,revision:1,enabled:true,sections:['deals.view','documents.print'],write_sections:['documents.manage']};
 await expect(call('SET_ACCESS',{...body,user_id:30})).rejects.toThrow('DEDICATED_PROJECT_ACCOUNT_REQUIRED');await expect(call('SET_ACCESS',{...body,sections:['deals.view']})).rejects.toThrow('ACCESS_DEPENDENCIES_REQUIRED');expect((await call('SET_ACCESS',body)).revision).toBe(2);await expect(call('SET_ACCESS',body)).rejects.toThrow('STALE_PROJECT_ACCESS');
 expect((await rpc('read_company_project_workspace',[created.id,null,'projects'])).projects).toHaveLength(1);
 await call('SET_ACCESS',{...body,revision:2,enabled:false});await expect(rpc('read_company_project_workspace',[created.id,plaza,'deals'])).rejects.toThrow();
});
it('creates empty resources atomically, rejects other projects and existing financial history',async()=>{
 const r=await call('RESOURCE',{project_revision:2,resource:'cash_desks',id:null,name:'Own empty desk'});expect((await setup()).cash_desks.find(x=>x.id===r.id).project_id).toBe(plaza);
 await expect(call('RESOURCE',{project_revision:2,resource:'cash_desks',id:'00000000-0000-4000-8000-000000000002',name:''})).rejects.toThrow('RESOURCE_OWNED_BY_OTHER_PROJECT');
 const r2=await call('RESOURCE',{project_revision:2,resource:'warehouses',id:null,name:'Own warehouse'});expect((await setup()).warehouses.find(x=>x.id===r2.id).project_id).toBe(plaza);
});
it('reviews demo links, denies paid/foreign/stale targets and keeps the historic signer untouched',async()=>{
 await db.exec("UPDATE projects SET code='DEMO-001' WHERE id=1;DELETE FROM payments WHERE deal_id=1;DELETE FROM expenses WHERE deal_id=1;UPDATE deals SET company_project_id=NULL,updated_at='stamp',company_director_snapshot=NULL WHERE id=1;");
 await db.exec("INSERT INTO payments(deal_id,cash_desk_id,amount_minor,currency,status) VALUES(1,'00000000-0000-4000-8000-000000000001',1,'USD','VOIDED')");expect((await rpc('read_company_project_unbound_deals',[30,plaza,0])).records[0].eligible).toBe(false);await expect(call('BIND_DEMO_DEAL',{project_revision:2,deal_id:1,expected_updated_at:'stamp'})).rejects.toThrow('DEAL_MIGRATION_REVIEW_REQUIRED');await db.exec('DELETE FROM payments WHERE deal_id=1');
 await db.exec("UPDATE units SET archived_at='archived' WHERE id=1");expect((await rpc('read_company_project_unbound_deals',[30,plaza,0])).records).toEqual([]);await db.exec("UPDATE units SET archived_at=NULL WHERE id=1");
 const preview=await rpc('read_company_project_unbound_deals',[30,plaza,0]);expect(preview.records[0]).toMatchObject({id:1,eligible:true});
 await expect(call('BIND_DEMO_DEAL',{project_revision:2,deal_id:1,expected_updated_at:'old'})).rejects.toThrow('STALE_DEMO_DEAL');
 await expect(call('BIND_DEMO_DEAL',{project_revision:1,deal_id:1,expected_updated_at:'stamp'},crypto.randomUUID(),30,tower)).rejects.toThrow('PROJECT_DEAL_NOT_FOUND');
 const r=await call('BIND_DEMO_DEAL',{project_revision:2,deal_id:1,expected_updated_at:'stamp'});expect(r.signer_review_required).toBe(true);expect((await db.query('SELECT company_director_snapshot FROM deals WHERE id=1')).rows[0].company_director_snapshot).toBeNull();
});
it('restricts admin commands and audit tables from browser roles',async()=>{await db.exec('SET ROLE authenticated');await expect(setup()).rejects.toThrow();await expect(db.query('SELECT * FROM company_project_admin_commands')).rejects.toThrow();await db.exec('RESET ROLE');});

it('keeps configured access when registry details change and rejects removing owned history',async()=>{
 const payload={name:'Plaza edited',code:'TOZON_PLAZA',partners:[],members:[{user_id:10,project_role:'PARTNER'},{user_id:created.id,project_role:'MANAGER'}],complex_ids:[1]};
 await rpc('save_company_project_draft',[plaza,2,payload,30]);expect((await setup()).members.find(x=>x.id===created.id).revision).toBe(3);
 await expect(rpc('save_company_project_draft',[plaza,3,{...payload,members:[payload.members[0]]},30])).rejects.toThrow('MEMBERSHIP_HAS_ACCESS_HISTORY');
 await expect(rpc('save_company_project_draft',[plaza,3,{...payload,complex_ids:[]},30])).rejects.toThrow('COMPLEX_HAS_PROJECT_HISTORY');
});
