import {it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {prepareBuyerAcceptance} from '../../../scripts/buyer_acceptance_prepare.js';
it('isolates all acceptance fixtures/migrations and preserves PUBLIC as a role, not a schema',async()=>{
 const db=new PGlite(),plan=prepareBuyerAcceptance('buyer_acceptance_a61f204cb873');
 try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls');
  for(const part of plan.parts)await db.exec(`begin;set local search_path=${plan.scope},pg_catalog;${part.sql}commit;`);
  expect((await db.query("select count(*)::int n from pg_tables where schemaname='public'")).rows[0].n).toBe(0);
  expect((await db.query('select count(*)::int n from pg_tables where schemaname=$1',[plan.scope])).rows[0].n).toBeGreaterThan(20);
  for(const role of ['anon','authenticated'])expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') ok",[role,`${plan.scope}.buyer_portal_contracts(bigint)`])).rows[0].ok).toBe(false);
  await db.exec(plan.cleanup);expect((await db.query('select count(*)::int n from pg_namespace where nspname=$1',[plan.scope])).rows[0].n).toBe(0);
 }finally{await db.close();}
},20000);
it('rejects unsafe or non-test namespaces before producing SQL',()=>{
 for(const name of ['public','buyer_acceptance_foo','buyer_acceptance_123456789012;drop table deals','buyer_acceptance_123456789012_extra'])expect(()=>prepareBuyerAcceptance(name)).toThrow('INVALID_ACCEPTANCE_SCOPE');
});
