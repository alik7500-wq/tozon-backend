import {it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
it('keeps passport sessions inaccessible to anon/authenticated and separate from finance',async()=>{
 const db=new PGlite();
 try{
 await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create table users(id integer primary key);');
 await db.exec(readFileSync(new URL('../../../supabase/migrations/20261029091355_telegram_passport_sessions.sql',import.meta.url),'utf8'));
 await db.exec(readFileSync(new URL('../../../supabase/migrations/20261029094000_telegram_passport_bindings.sql',import.meta.url),'utf8'));
 const {rows}=await db.query("select relrowsecurity from pg_class where oid='public.telegram_passport_sessions'::regclass");expect(rows[0].relrowsecurity).toBe(true);
 for(const role of ['anon','authenticated']){
  const q=await db.query(`select has_table_privilege('${role}','public.telegram_passport_sessions','SELECT') as read,has_table_privilege('${role}','public.telegram_passport_sessions','INSERT') as write`);
  expect(q.rows[0]).toEqual({read:false,write:false});
  expect((await db.query(`select has_table_privilege('${role}','public.telegram_passport_bindings','SELECT') as read`)).rows[0].read).toBe(false);
 }
 await db.exec("insert into users values(1); insert into telegram_passport_sessions(user_id,token_hash,expires_at) values (1,repeat('a',64),now()+interval '15 minutes');");
 expect((await db.query('select status from telegram_passport_sessions')).rows[0].status).toBe('PENDING');
 }finally{await db.close();}
});
