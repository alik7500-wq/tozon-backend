import { beforeAll, afterAll, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
let db;
beforeAll(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table users(id integer primary key,name text,is_active integer default 1,is_sales_rep boolean default false);
 create table projects(id integer primary key);
 create table leads(id serial primary key,full_name text,phone text,secondary_phone text,source text,status text,notes text,responsible_user_id integer,interested_project_id integer,assigned_at timestamptz,created_at text,updated_at text,archived_at text);
 create table lead_notes(id serial primary key,lead_id integer,author_user_id integer,body text,created_at text);
 create table tasks(id serial primary key,lead_id integer,assigned_user_id integer,created_by integer,type text,title text,description text,client_name text,phone text,due_date text,priority text,status text);
 create unique index task_open_call on tasks(lead_id,type) where status='OPEN' and type='CALL';
 create table lead_assignment_history(id serial primary key,lead_id integer,to_user_id integer,assigned_by_user_id integer,assignment_type text,reason text);
 insert into users(id,name,is_sales_rep) values(1,'Admin',false),(2,'Manager',true);insert into projects values(3);`);
 const sql=readFileSync('supabase/migrations/20261101210158_lead_intake_import_google_forms.sql','utf8');await db.exec(sql);
 const fix=readFileSync('supabase/migrations/20261101211750_fix_lead_intake_employee_active_flag.sql','utf8');await db.exec(fix);await db.exec(fix);
},30000);
afterAll(async()=>db?.close());
async function intake(key,phone='900123456',extra={},settings={source:'WEBINAR',campaign:'Webinar',manager_id:2,project_id:3}){
 return (await db.query('select crm_intake_lead($1,$2,$3::jsonb,$4::jsonb,1,null) as r',['FILE',key,JSON.stringify({full_name:'Test',phone,notes:'Answer',...extra}),JSON.stringify(settings)])).rows[0].r;
}
it('creates assigned lead, inquiry and call task atomically, with idempotent retry',async()=>{
 const first=await intake('first');expect(first.outcome).toBe('CREATED');expect(first.task_id).toBeTruthy();
 const retry=await intake('first');expect(retry.outcome).toBe('DUPLICATE');expect(retry.lead_id).toBe(first.lead_id);
 expect((await db.query('select count(*)::int n from tasks')).rows[0].n).toBe(1);
});
it('matches formatted / secondary phones, records repeat without changing owner or status',async()=>{
 const id=(await intake('first')).lead_id;await db.query("update leads set status='WON',secondary_phone='+992 (900) 222-333' where id=$1",[id]);
 const repeat=await intake('second','+992 900 222 333',{full_name:'Different name'});expect(repeat.outcome).toBe('REPEAT');expect(repeat.lead_id).toBe(id);
 const row=(await db.query('select full_name,status,responsible_user_id from leads where id=$1',[id])).rows[0];expect(row).toEqual({full_name:'Test',status:'WON',responsible_user_id:2});
 expect((await db.query('select count(*)::int n from tasks')).rows[0].n).toBe(1);
 expect((await db.query('select body from lead_notes where lead_id=$1',[id])).rows[0].body).toContain('Different name');
});
it('skips archived / ambiguous matches and rejects unavailable manager without partial writes',async()=>{
 await db.exec("insert into leads(full_name,phone,archived_at) values('Old','+992900000001','2026-01-01');insert into leads(full_name,phone) values('A','900000002'),('B','+992900000002');");
 expect((await intake('archived','900000001')).outcome).toBe('ARCHIVED');
 expect((await intake('ambiguous','900000002')).outcome).toBe('AMBIGUOUS');
 await expect(intake('bad-manager','900000003',{}, {source:'WEBINAR',campaign:'Event',manager_id:999})).rejects.toThrow('Manager unavailable');
 expect((await db.query("select count(*)::int n from crm_lead_inquiries where external_key='bad-manager'")).rows[0].n).toBe(0);
});
it('external source uses server configuration and fails after deactivation',async()=>{
 const id=(await db.query("insert into crm_lead_integrations(name,source,campaign,token_hash,created_by) values('Google','GOOGLE_FORM','Real event','hash',1) returning id")).rows[0].id;
 const args=['GOOGLE:'+id,'form-answer',JSON.stringify({phone:'900000004',full_name:'Form'}),JSON.stringify({manager_id:999,campaign:'FORGED',source:'INSTAGRAM'}),id];
 const r=(await db.query('select crm_intake_lead($1,$2,$3::jsonb,$4::jsonb,null,$5::uuid) r',args)).rows[0].r;expect(r.outcome).toBe('CREATED');
 expect((await db.query('select source,campaign from crm_lead_inquiries where lead_id=$1',[r.lead_id])).rows[0]).toEqual({source:'GOOGLE_FORM',campaign:'Real event'});
 await db.query('update crm_lead_integrations set is_active=false where id=$1',[id]);await expect(db.query('select crm_intake_lead($1,$2,$3::jsonb,$4::jsonb,null,$5::uuid) r',args)).rejects.toThrow('Integration inactive');
});
it('private intake tables and RPCs are unavailable to browser roles',async()=>{
 const r=(await db.query("select has_table_privilege('anon','crm_lead_integrations','SELECT') a,has_table_privilege('authenticated','crm_lead_inquiries','SELECT') b,has_function_privilege('anon','crm_intake_lead(text,text,jsonb,jsonb,integer,uuid)','EXECUTE') c,has_table_privilege('service_role','crm_lead_inquiries','DELETE') d")).rows[0];expect(r).toEqual({a:false,b:false,c:false,d:false});
 expect((await db.query("select count(*)::int n from pg_class where relname in('crm_lead_integrations','crm_lead_inquiries') and relrowsecurity")).rows[0].n).toBe(2);
});

it('rejects deactivated integer-flag managers without creating a lead',async()=>{
 await db.exec("insert into users(id,name,is_active,is_sales_rep) values(9,'Inactive',0,true)");
 await expect(intake('inactive-manager','900000099',{}, {source:'WEBINAR',campaign:'Event',manager_id:9})).rejects.toThrow('Manager unavailable');
 expect((await db.query("select count(*)::int n from leads where phone='+992900000099'")).rows[0].n).toBe(0);
});
