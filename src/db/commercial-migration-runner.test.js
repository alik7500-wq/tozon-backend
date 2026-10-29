import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { commercialInstall } from './commercial-install.js';
import { commercialMigrations } from './commercial-install-manifest.js';
import { prepareMigrations, runCommercialMigrations } from './commercial-migration-runner.js';

const ref = 'abcdefghijklmnopqrst';
const databases = [];
function database() {
  const pg = new PGlite();
  databases.push(pg);
  // PGlite exec supports multi-statement batches; query supports parameters.
  const adapter = tx => ({
    query: async (sql, params = []) => params.length
      ? (await tx.query(sql, params)).rows
      : (await tx.exec(sql)).at(-1)?.rows || [],
  });
  return { pg, db: { transaction: fn => pg.transaction(tx => fn(adapter(tx))) } };
}
afterEach(async () => { await Promise.all(databases.splice(0).map(pg => pg.close())); });

describe('commercial PostgreSQL migration runner', () => {
  it('installs and repeats without duplicating state', async () => {
    const { pg, db } = database();
    expect((await runCommercialMigrations(db, commercialMigrations, ref)).applied).toEqual(['0001_bootstrap']);
    expect((await runCommercialMigrations(db, commercialMigrations, ref)).applied).toEqual([]);
    expect((await pg.query('SELECT count(*)::int AS n FROM tozon_install.bootstrap')).rows[0].n).toBe(1);
  });
  it('rolls back the entire fresh install after SQL failure', async () => {
    const { pg, db } = database();
    await expect(runCommercialMigrations(db, [...commercialMigrations, {
      name: '0002_broken', sql: 'SELECT nonexistent_column FROM nonexistent_table',
    }], ref)).rejects.toThrow();
    expect((await pg.query("SELECT to_regnamespace('tozon_install') AS schema")).rows[0].schema).toBeNull();
  });
  it('preserves existing history and rolls back a failed upgrade', async () => {
    const { pg, db } = database();
    await runCommercialMigrations(db, commercialMigrations, ref);
    await expect(runCommercialMigrations(db, [...commercialMigrations, {
      name: '0002_broken', sql: 'CREATE TABLE tozon_install.partial(id int); SELECT 1/0;',
    }], ref)).rejects.toThrow();
    expect((await pg.query("SELECT to_regclass('tozon_install.partial') AS t")).rows[0].t).toBeNull();
    expect((await pg.query('SELECT count(*)::int AS n FROM tozon_install.migrations')).rows[0].n).toBe(1);
  });
  it('refuses changed or removed applied migrations', async () => {
    const { db } = database();
    await runCommercialMigrations(db, commercialMigrations, ref);
    await expect(runCommercialMigrations(db, [{ ...commercialMigrations[0], sql: 'SELECT 1' }], ref))
      .rejects.toThrow('HISTORY_MISMATCH');
    await expect(runCommercialMigrations(db, [{ name: '0002_other', sql: 'SELECT 1' }], ref))
      .rejects.toThrow('HISTORY_MISMATCH');
  });
  it('refuses another project identity', async () => {
    const { db } = database();
    await runCommercialMigrations(db, commercialMigrations, ref);
    await expect(runCommercialMigrations(db, commercialMigrations, 'zyxwvutsrqponmlkjihg'))
      .rejects.toThrow('TARGET_MISMATCH');
  });
  it('refuses an existing application database', async () => {
    const { pg, db } = database();
    await pg.exec('CREATE TABLE public.existing_customer(id int)');
    await expect(runCommercialMigrations(db, commercialMigrations, ref)).rejects.toThrow('EMPTY_PUBLIC_SCHEMA');
    expect((await pg.query("SELECT to_regnamespace('tozon_install') AS schema")).rows[0].schema).toBeNull();
  });
  it('keeps installer metadata inaccessible to API roles', async () => {
    const { pg, db } = database();
    await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
    await runCommercialMigrations(db, commercialMigrations, ref);
    for (const role of ['anon', 'authenticated']) {
      await pg.exec(`SET ROLE ${role}`);
      try {
        await expect(pg.query('SELECT * FROM tozon_install.target')).rejects.toThrow('permission denied');
      } finally { await pg.exec('RESET ROLE'); }
    }
  });
  it('refuses inserting migrations before the last applied version', async () => {
    const { db } = database();
    const later = [{ name: '0002_later', sql: 'SELECT 1' }];
    await runCommercialMigrations(db, later, ref);
    await expect(runCommercialMigrations(db, [...commercialMigrations, ...later], ref))
      .rejects.toThrow('ORDER_MISMATCH');
  });
  it('rejects empty and duplicate manifests', async () => {
    expect(() => prepareMigrations([...commercialMigrations, ...commercialMigrations])).toThrow('INVALID_');
    const { db } = database();
    await expect(runCommercialMigrations(db, [], ref)).rejects.toThrow('EMPTY_');
  });
  it('plans without a network connection and excludes credentials', async () => {
    const env = {
      COMMERCIAL_INSTALL_CONFIRM: 'ISOLATED_TEST_DATABASE',
      COMMERCIAL_SUPABASE_PROJECT_REF: ref,
      COMMERCIAL_DATABASE_URL: `postgresql://postgres:secret@db.${ref}.supabase.co:5432/postgres`,
    };
    const plan = await commercialInstall(['--plan'], env);
    expect(plan.crmReady).toBe(false);
    expect(JSON.stringify(plan)).not.toContain('secret');
    await expect(commercialInstall(['--apply'], env)).rejects.toThrow('USE_');
  });
});
