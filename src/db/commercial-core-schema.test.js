import { afterEach, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { commercialCoreMigrations } from './commercial-install-manifest.js';
import { prepareMigrations, runCommercialMigrations } from './commercial-migration-runner.js';
import { renderCommercialInstallSql } from './commercial-install-sql.js';
import { commercialInstall } from './commercial-install.js';

const ref = 'yaolkwbnhnacxxjpgiyu';
const env = {
 COMMERCIAL_INSTALL_CONFIRM: 'ISOLATED_TEST_DATABASE',
 COMMERCIAL_SUPABASE_PROJECT_REF: ref,
 COMMERCIAL_DATABASE_URL: `postgresql://postgres:unused@db.${ref}.supabase.co:5432/postgres`,
};
const opened = [];
async function database() {
 const pg = new PGlite(); opened.push(pg);
 await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;');
 const adapt = tx => ({query: async (sql, params=[]) => params.length ? (await tx.query(sql,params)).rows : (await tx.exec(sql)).at(-1)?.rows || []});
 return {pg, db: {transaction: fn => pg.transaction(tx => fn(adapt(tx)))}};
}
afterEach(async () => Promise.all(opened.splice(0).map(pg => pg.close())));

it('plans and exports the core offline without leaking a connection URL',async () => {
 const plan=await commercialInstall(['--plan-core'],env);
 expect(plan.scope).toBe('core_schema_preview'); expect(plan.crmReady).toBe(false);
 expect(plan.migrations).toHaveLength(2);
 const sql=await commercialInstall(['--export-core-sql'],env);
 expect(sql).toContain('DO $commercial_install$');
 expect(sql).not.toContain('postgresql://');
});

it('SQL transport preserves an existing core on a failed upgrade and refuses old insertions',async () => {
 const {pg}=await database();
 await pg.exec(renderCommercialInstallSql(commercialCoreMigrations,env));
 const history=(await pg.query('SELECT * FROM tozon_install.migrations ORDER BY name')).rows;
 await expect(pg.exec(renderCommercialInstallSql([...commercialCoreMigrations,{name:'0003_broken',sql:'CREATE TABLE public.partial_upgrade(id int); SELECT 1/0;'}],env))).rejects.toThrow();
 expect((await pg.query("SELECT to_regclass('public.partial_upgrade') t")).rows[0].t).toBeNull();
 expect((await pg.query('SELECT * FROM tozon_install.migrations ORDER BY name')).rows).toEqual(history);
 await expect(pg.exec(renderCommercialInstallSql([...commercialCoreMigrations,{name:'0000_earlier',sql:'SELECT 1'}],env))).rejects.toThrow('ORDER_MISMATCH');
});

it('installs the same core via driver and SQL transport, preserving checksums on repeat', async () => {
 const {pg,db} = await database();
 const first = await runCommercialMigrations(db, commercialCoreMigrations,ref);
 expect(first.applied).toEqual(['0001_bootstrap','0002_core_preview']);
 const before = (await pg.query('SELECT * FROM tozon_install.migrations ORDER BY name')).rows;
 await pg.exec(renderCommercialInstallSql(commercialCoreMigrations,env));
 expect((await pg.query('SELECT * FROM tozon_install.migrations ORDER BY name')).rows).toEqual(before);
 expect((await pg.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public' AND rowsecurity")).rows[0].n).toBe(15);
});

it('SQL transport installs fresh, rejects changed history, and matches the driver', async () => {
 const {pg,db} = await database();
 await pg.exec(renderCommercialInstallSql(commercialCoreMigrations,env));
 expect((await runCommercialMigrations(db,commercialCoreMigrations,ref)).applied).toEqual([]);
 const modified = commercialCoreMigrations.map((m,i) => i ? {...m,sql:m.sql+'\n-- changed'} : m);
 await expect(pg.exec(renderCommercialInstallSql(modified,env))).rejects.toThrow('HISTORY_MISMATCH');
 expect((await pg.query('SELECT name,checksum FROM tozon_install.migrations ORDER BY name')).rows)
  .toEqual(prepareMigrations(commercialCoreMigrations).map(({name,checksum})=>({name,checksum})));
});

it('SQL transport rolls back a failed fresh installation and refuses existing tables',async () => {
 const {pg} = await database();
 await expect(pg.exec(renderCommercialInstallSql([...commercialCoreMigrations,{name:'0003_fail',sql:'SELECT 1/0'}],env))).rejects.toThrow();
 expect((await pg.query("SELECT to_regnamespace('tozon_install') s")).rows[0].s).toBeNull();
 expect((await pg.query("SELECT to_regclass('public.deals') t")).rows[0].t).toBeNull();
 await pg.exec('CREATE TABLE public.existing_data(id int)');
 await expect(pg.exec(renderCommercialInstallSql(commercialCoreMigrations,env))).rejects.toThrow('EMPTY_PUBLIC_SCHEMA');
});

it('denies API roles all table operations and sequence access',async () => {
 const {pg} = await database();
 await pg.exec(renderCommercialInstallSql(commercialCoreMigrations,env));
 for (const role of ['anon','authenticated']) {
  const {rows} = await pg.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','tozon_install') AND c.relkind='r' AND
   (has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT') OR
    has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_table_privilege($1,c.oid,'TRUNCATE'))`,[role]);
  expect(rows).toEqual([]);
  await pg.exec(`SET ROLE ${role}`);
  try { await expect(pg.query('SELECT * FROM public.users')).rejects.toThrow('permission denied'); }
  finally { await pg.exec('RESET ROLE'); }
 }
});

it('supports an isolated sale and payment as backend role, and prevents double sales',async () => {
 const {pg} = await database();
 await pg.exec(renderCommercialInstallSql(commercialCoreMigrations,env));
 await pg.exec('SET ROLE service_role');
 const insert = async (table,fields) => {
  const keys=Object.keys(fields);
  return (await pg.query(`INSERT INTO public.${table} (${keys.join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING id`,Object.values(fields))).rows[0].id;
 };
 const timestamps={created_at:'2026-10-28T00:00:00Z',updated_at:'2026-10-28T00:00:00Z'};
 const user=await insert('users',{name:'Demo',email:'demo@example.invalid',password_hash:'test-only',role:'ADMIN',...timestamps});
 const project=await insert('projects',{name:'Demo',code:'DEMO',developer_name:'Example',address:'Example',...timestamps});
 const building=await insert('buildings',{project_id:project,name:'A',code:'A',...timestamps});
 const section=await insert('sections',{building_id:building,name:'A',code:'A',...timestamps});
 const floor=await insert('floors',{section_id:section,floor_number:1,name:'1',...timestamps});
 const unit=await insert('units',{floor_id:floor,unit_number:'1',rooms:2,area_m2_x100:7000,price_per_m2_minor:10000,...timestamps});
 const lead=await insert('leads',{full_name:'Example Buyer',phone:'TEST',...timestamps});
 const dealData={lead_id:lead,unit_id:unit,responsible_user_id:user,status:'SIGNED',base_price_minor:700000,final_price_minor:700000,deal_date:'2026-10-28',...timestamps};
 const deal=await insert('deals',dealData);
 await expect(insert('deals',dealData)).rejects.toThrow('idx_deals_active_unit');
 const schedule=await insert('deal_payment_schedules',{deal_id:deal,payment_number:1,due_date:'2026-11-28',amount_minor:700000,...timestamps});
 await insert('payments',{deal_id:deal,schedule_id:schedule,amount_minor:10000,payment_date:'2026-10-28',created_by_user_id:user,created_at:timestamps.created_at});
 expect((await pg.query('SELECT sum(amount_minor)::int total FROM public.payments WHERE deal_id=$1',[deal])).rows[0].total).toBe(10000);
 await expect(insert('payments',{deal_id:deal,amount_minor:-1,payment_date:'2026-10-28',created_at:timestamps.created_at})).rejects.toThrow();
});

it('SQL transport excludes credentials and rejects protected targets and wrong installation identity',async () => {
 const {pg} = await database();
 const sql=renderCommercialInstallSql(commercialCoreMigrations,env);
 expect(sql).not.toContain('postgresql://'); expect(sql).not.toContain(':unused@');
 expect(()=>renderCommercialInstallSql(commercialCoreMigrations,{...env,COMMERCIAL_SUPABASE_PROJECT_REF:'yeslzrrcwgcqfxhgbrqk'})).toThrow('PROTECTED');
 await pg.exec(sql);
 const other='abcdefghijklmnopqrst';
 await expect(pg.exec(renderCommercialInstallSql(commercialCoreMigrations,{...env,COMMERCIAL_SUPABASE_PROJECT_REF:other,COMMERCIAL_DATABASE_URL:`postgresql://postgres:unused@db.${other}.supabase.co:5432/postgres`}))).rejects.toThrow('TARGET_MISMATCH');
});
