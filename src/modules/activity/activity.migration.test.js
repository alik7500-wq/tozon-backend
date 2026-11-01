import{it,expect}from'vitest';import{PGlite}from'@electric-sql/pglite';import{readFileSync}from'node:fs';
it('restricts activity storage to the backend and keeps the log append-only for service_role',async()=>{
 const db=new PGlite();try{await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create table users(id int primary key);');
 const sql=readFileSync('supabase/migrations/20261101194726_crm_user_activity_log.sql','utf8');await db.exec(sql);await db.exec(sql);
 const p=await db.query("select has_table_privilege('anon','crm_activity_events','SELECT') anon,has_table_privilege('authenticated','crm_user_presence','SELECT') auth,has_table_privilege('service_role','crm_activity_events','INSERT') ins,has_table_privilege('service_role','crm_activity_events','UPDATE') upd,has_table_privilege('service_role','crm_activity_events','DELETE') del");expect(p.rows[0]).toEqual({anon:false,auth:false,ins:true,upd:false,del:false});
 expect((await db.query("select count(*)::int n from pg_class where relname in('crm_user_presence','crm_activity_events') and relrowsecurity")).rows[0].n).toBe(2);
 }finally{await db.close()}
},30000);
