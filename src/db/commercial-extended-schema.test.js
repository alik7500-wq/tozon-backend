import {afterAll,beforeAll,expect,it} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {commercialSchemaSmokeSql} from './commercial-schema-smoke.js';
import {readFileSync} from 'node:fs';
import {commercialCoreMigrations,commercialSchemaMigrations} from './commercial-install-manifest.js';
import {renderCommercialInstallSql} from './commercial-install-sql.js';
import {prepareMigrations} from './commercial-migration-runner.js';
const ref='yaolkwbnhnacxxjpgiyu';
const env={COMMERCIAL_INSTALL_CONFIRM:'ISOLATED_TEST_DATABASE',COMMERCIAL_SUPABASE_PROJECT_REF:ref,COMMERCIAL_DATABASE_URL:`postgresql://postgres:unused@db.${ref}.supabase.co:5432/postgres`};
const pg=new PGlite();
const snapshot=JSON.parse(readFileSync(new URL('../../docs/commercial/production-schema-metadata.json',import.meta.url)));
beforeAll(async()=>{
 await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; GRANT USAGE ON SCHEMA public TO service_role;');
 // Exercise the real upgrade path of the already-provisioned cloud project.
 await pg.exec(renderCommercialInstallSql(commercialCoreMigrations,env));
 await pg.exec(renderCommercialInstallSql(commercialSchemaMigrations,env));
},30000);
afterAll(async()=>pg.close());
it('reconciles every captured public column, type and nullability',async()=>{
 const {rows}=await pg.query(`SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) type,a.attnotnull AS "notnull" FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped`);
 for(const t of snapshot.tables)for(const c of t.columns){
  expect(rows.find(r=>r.relname===t.name&&r.attname===c.name),t.name+'.'+c.name).toMatchObject({type:c.type,notnull:c.notnull});
 }
 expect(new Set(rows.map(r=>r.relname)).size).toBe(74);
});
it('installs all functions/triggers with backend-only privileges and invoker execution',async()=>{
 const {rows}=await pg.query(`SELECT p.proname,p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','tozon_internal')`);
 expect(rows).toHaveLength(45);
 for(const r of rows){expect(r.prosecdef).toBe(false);expect(r.anon).toBe(false);expect(r.authenticated).toBe(false);expect(r.proconfig.some(x=>x.startsWith('search_path='))).toBe(true);}
 expect((await pg.query("SELECT count(*)::int n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal")).rows[0].n).toBe(16);
 expect((await pg.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname IN ('public','tozon_internal') AND NOT rowsecurity")).rows[0].n).toBe(0);
});
it('keeps real records absent and seeds only generic roles, empty settings and zero counter',async()=>{
 expect((await pg.query('SELECT count(*)::int n FROM public.users')).rows[0].n).toBe(0);
 expect((await pg.query('SELECT count(*)::int n FROM public.payments')).rows[0].n).toBe(0);
 expect((await pg.query('SELECT last_number FROM tozon_internal.customer_pko_counter')).rows[0].last_number).toBe(0);
 expect((await pg.query('SELECT count(*)::int n FROM public.crm_roles')).rows[0].n).toBe(6);
 expect((await pg.query("SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='sms_messages' AND column_name='sender_name'")).rows[0].column_default).toBeNull();
});
it('repeats without changing migration history',async()=>{
 const before=(await pg.query('SELECT * FROM tozon_install.migrations ORDER BY name')).rows;
 await pg.exec(renderCommercialInstallSql(commercialSchemaMigrations,env));
 expect((await pg.query('SELECT * FROM tozon_install.migrations ORDER BY name')).rows).toEqual(before);
 expect(before.map(({name,checksum})=>({name,checksum}))).toEqual(prepareMigrations(commercialSchemaMigrations).map(({name,checksum})=>({name,checksum})));
});
it('allows backend document functions and technical counters without customer data',async()=>{
 await pg.exec('BEGIN; SET LOCAL ROLE service_role;');
 try {
  expect((await pg.query("SELECT tozon_internal.is_customer_pko('{\"deal_id\":1,\"operation_type\":\"STANDARD\",\"settlement_method\":\"CASH\"}'::jsonb) ok")).rows[0].ok).toBe(true);
  // Finance authorization helper must reject an unknown actor.
  await pg.exec('SAVEPOINT denied');
  await expect(pg.query('SELECT public.cost_require_writer(999999)')).rejects.toThrow('COST_ACCESS_DENIED');
  await pg.exec('ROLLBACK TO denied');
 }finally{await pg.exec('ROLLBACK');}
});

it('executes synthetic finance/assignment/numbering scenario and rolls it back',async()=>{
 const result=await pg.exec(commercialSchemaSmokeSql);
 expect(result.at(-1).rows[0]).toEqual({schema_smoke:'passed',users_remaining:0,payments_remaining:0,counter_remaining:0});
});
