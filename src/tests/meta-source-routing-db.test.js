import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

let db; let sequence = 0;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE users(id bigint PRIMARY KEY); INSERT INTO users VALUES (1),(2);
    CREATE TABLE projects(id bigint PRIMARY KEY,name text,archived_at timestamptz);
    INSERT INTO projects VALUES(11,'Plaza',NULL),(12,'Garden',NULL),(13,'Archived',now());
    GRANT SELECT,UPDATE ON users,projects TO service_role;`);
  await db.exec(await readFile(new URL('../../supabase/migrations/20261109184102_meta_source_project_routing.sql', import.meta.url), 'utf8'));
});
afterAll(async () => { await db?.close(); });
async function sync(owner, externalId, metaUser = '100') {
  const digest = (++sequence).toString(16).padStart(64, '0');
  await db.query(`INSERT INTO meta_source_oauth_states(state_digest,owner_user_id,expires_at,consumed_at) VALUES($1,$2,now()+interval '10 minutes',now())`, [digest, owner]);
  await db.query(`SELECT sync_meta_source_catalogue($1,$2,'Fixture','v1.fixture',NULL,$3::jsonb,$4)`, [owner, metaUser, JSON.stringify([
    { channel: 'INSTAGRAM_MESSAGES', external_id: externalId, page_id: '200', name: 'Fixture source', encrypted_access_token: 'v1.fixture-page' }
  ]), digest]);
  return (await db.query(`SELECT id,project_id FROM meta_project_sources WHERE external_id=$1`, [externalId])).rows[0];
}
async function bind(owner, source, project) {
  return (await db.query('SELECT bind_meta_project_source($1,$2,$3) AS changed', [owner, source, project])).rows[0].changed;
}
describe('Meta project bindings in PostgreSQL', () => {
  it('preserves explicit project bindings across reconnect and allows unassigning', async () => {
    let source = await sync(1, '300');
    expect(source.project_id).toBeNull();
    expect(await bind(1, source.id, 11)).toBe(true);
    source = await sync(1, '300');
    expect(Number(source.project_id)).toBe(11);
    expect(await bind(1, source.id, null)).toBe(true);
  });
  it('rejects foreign ownership, unknown projects and archived projects', async () => {
    const source = await sync(1, '300');
    expect(await bind(2, source.id, 12)).toBe(false);
    expect(await bind(1, source.id, 999)).toBe(false);
    expect(await bind(1, source.id, 13)).toBe(false);
    expect((await db.query('SELECT project_id FROM meta_project_sources WHERE id=$1', [source.id])).rows[0].project_id).toBeNull();
  });
  it('cannot silently transfer a source to another administrator', async () => {
    await sync(1, '300');
    await expect(sync(2, '300')).rejects.toThrow('Source belongs to another connection');
    expect((await db.query('SELECT count(*) AS count FROM meta_source_connections WHERE owner_user_id=2')).rows[0].count).toBe(0);
  });
  it('removes missing asset credentials and rejects binding to unavailable assets', async () => {
    const source = await sync(1, '300');
    await sync(1, '301');
    const row = (await db.query('SELECT available,encrypted_access_token FROM meta_project_sources WHERE id=$1', [source.id])).rows[0];
    expect(row).toEqual({ available: false, encrypted_access_token: null });
    expect(await bind(1, source.id, 11)).toBe(false);
  });
  it('disconnect clears tokens and all bindings and blocks pending callbacks', async () => {
    const source = await sync(1, '300');
    await bind(1, source.id, 11);
    const digest = 'f'.repeat(64);
    await db.query(`INSERT INTO meta_source_oauth_states VALUES($1,1,now()+interval '10 minutes',now(),NULL)`, [digest]);
    await db.query('SELECT disconnect_meta_source_connection(1)');
    const row = (await db.query('SELECT available,project_id,encrypted_access_token FROM meta_project_sources WHERE id=$1', [source.id])).rows[0];
    expect(row).toEqual({ available: false, project_id: null, encrypted_access_token: null });
    expect(await bind(1, source.id, 11)).toBe(false);
    await expect(db.query(`SELECT sync_meta_source_catalogue(1,'100','Fixture','v1.fixture',NULL,'[]'::jsonb,$1)`, [digest])).rejects.toThrow('Authorization cancelled or expired');
  });
  it('keeps all credentials and RPCs unavailable to public API roles', async () => {
    for (const role of ['anon','authenticated']) {
      const permissions = (await db.query(`SELECT has_table_privilege($1,'meta_project_sources','SELECT') AS source,
        has_table_privilege($1,'meta_source_connections','SELECT') AS connection,
        has_function_privilege($1,'bind_meta_project_source(bigint,uuid,bigint)','EXECUTE') AS binding`, [role])).rows[0];
      expect(permissions).toEqual({ source: false, connection: false, binding: false });
    }
    expect((await db.query(`SELECT count(*) AS count FROM pg_class WHERE relname IN ('meta_project_sources','meta_source_connections','meta_source_oauth_states') AND relrowsecurity`)).rows[0].count).toBe(3);
  });
  it('runs binding RPCs as service_role while respecting token expiry', async () => {
    const source = await sync(1, '300');
    await db.exec('SET ROLE service_role');
    try { expect(await bind(1, source.id, 12)).toBe(true); }
    finally { await db.exec('RESET ROLE'); }
    await db.exec("UPDATE meta_source_connections SET token_expires_at=now()-interval '1 second' WHERE owner_user_id=1");
    expect(await bind(1, source.id, 11)).toBe(false);
    expect(Number((await db.query('SELECT project_id FROM meta_project_sources WHERE id=$1', [source.id])).rows[0].project_id)).toBe(12);
  });
});
