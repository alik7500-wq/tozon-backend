import { beforeAll, afterAll, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
let db;
const account='17841447499018452';
beforeAll(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create table leads(id serial primary key,full_name text not null,phone text not null,source text,status text,notes text,created_at text,updated_at text);
 create table tozon_instagram_connections(instagram_user_id text,status text);
 insert into tozon_instagram_connections values('${account}','connected');`);
 await db.exec(readFileSync('supabase/migrations/20261112120738_instagram_live_inbox.sql','utf8'));
 await db.query("insert into crm_instagram_rollout(account_id,activated_at) values($1,now()-interval '1 hour')",[account]);
},30000);
afterAll(async()=>db?.close());
const message=(id,extra={})=>({message_id:id,text_content:'Салом 😊',created_at:new Date().toISOString(),is_echo:false,contentUnavailable:false,...extra});
async function store(contact,messages,options={}) {
 return (await db.query('select crm_instagram_store_thread($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) r',
 [account,contact,options.name||'Customer',options.preview||'Салом 😊',options.time||null,JSON.stringify(messages),options.cursor||null,options.complete||false,options.graphUpdated||null])).rows[0].r;
}
it('atomically creates one lead without a fake phone and deduplicates retries/messages',async()=>{
 const first=await store('101',[message('a')]);const retry=await store('101',[message('a')]);
 expect(first.created).toBe(true);expect(retry).toEqual({lead_id:first.lead_id,created:false});
 await store('101',[message('b')]);
 expect((await db.query("select count(*)::int n from crm_instagram_history where contact_id='101'")).rows[0].n).toBe(2);
 expect((await db.query('select phone,source,status from leads where id=$1',[first.lead_id])).rows[0]).toEqual({phone:'',source:'INSTAGRAM',status:'NEW'});
});
it('does not create leads from echoes or historical imports',async()=>{
 expect((await store('102',[message('echo',{is_echo:true})])).created).toBe(false);
 expect((await store('103',[message('old',{created_at:'2020-01-01T00:00:00Z'})])).created).toBe(false);
});
it('rejects unrelated accounts and rolls back invalid batches',async()=>{
 await expect(db.query("select crm_instagram_store_thread('99999','111',null,null,null)")).rejects.toThrow('Instagram disconnected');
 await expect(store('104',[message('good'),message('')])).rejects.toThrow('Invalid message id');
 expect((await db.query("select count(*)::int n from crm_instagram_history where contact_id='104'")).rows[0].n).toBe(0);
});
it('preserves webhook text when Graph omits it, but permits an explicit deletion',async()=>{
 await store('105',[message('web')]);await store('105',[message('web',{text_content:'',contentUnavailable:true})]);
 expect((await db.query("select body->>'text_content' t from crm_instagram_history where contact_id='105'")).rows[0].t).toBe('Салом 😊');
 await store('105',[message('web',{text_content:'',contentUnavailable:true,deleted:true})]);
 expect((await db.query("select body->>'deleted' t from crm_instagram_history where contact_id='105'")).rows[0].t).toBe('true');
});
it('older pages cannot replace latest cursors and reply refusals reset only on newer inbound',async()=>{
 const time=new Date(Date.now()-10000).toISOString();
 await store('106',[message('one',{created_at:time})],{complete:true,cursor:'LATEST'});
 await db.exec("update crm_instagram_threads set reply_blocked_until=now()+interval '1 day' where contact_id='106'");
 await store('106',[message('old',{created_at:'2020-01-01T00:00:00Z'})]);
 let row=(await db.query("select next_cursor,reply_blocked_until is not null blocked from crm_instagram_threads where contact_id='106'")).rows[0];
 expect(row).toEqual({next_cursor:'LATEST',blocked:true});
 await store('106',[message('new')]);
 expect((await db.query("select reply_blocked_until from crm_instagram_threads where contact_id='106'")).rows[0].reply_blocked_until).toBeNull();
});
it('blocks browser roles from private history, rollout settings and lead-creating RPC',async()=>{
 const row=(await db.query("select has_table_privilege('anon','crm_instagram_history','SELECT') a,has_table_privilege('authenticated','crm_instagram_threads','SELECT') b,has_function_privilege('anon','crm_instagram_store_thread(text,text,text,text,text,jsonb,text,boolean,text)','EXECUTE') c,has_function_privilege('authenticated','crm_instagram_store_thread(text,text,text,text,text,jsonb,text,boolean,text)','EXECUTE') d")).rows[0];
 expect(row).toEqual({a:false,b:false,c:false,d:false});
 expect((await db.query("select count(*)::int n from pg_class where relname like 'crm_instagram_%' and relkind='r' and relrowsecurity")).rows[0].n).toBe(3);
});
it('separates history and leads for identical contact and message IDs across connected accounts',async()=>{
 const second='17841447499018453';
 await db.query('insert into tozon_instagram_connections values($1,$2)',[second,'connected']);
 await db.query("insert into crm_instagram_rollout(account_id,activated_at) values($1,now()-interval '1 hour')",[second]);
 const first=await store('777',[message('shared-id')]);
 const other=(await db.query('select crm_instagram_store_thread($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) r',
 [second,'777','Second profile','Other message',null,JSON.stringify([message('shared-id',{text_content:'Other message'})]),null,true,null])).rows[0].r;
 expect(other.created).toBe(true);expect(other.lead_id).not.toBe(first.lead_id);
 const rows=(await db.query("select account_id,body->>'text_content' text from crm_instagram_history where contact_id='777' order by account_id")).rows;
 expect(rows).toEqual([{account_id:account,text:'Салом 😊'},{account_id:second,text:'Other message'}]);
});
