import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
let db, plaza, tower;
const payload = (extra = {}) => ({ name: 'Tozon Plaza', code: 'TOZON_PLAZA', location: 'Худжанд', director_name: 'Тестовый директор', director_authority: 'Тестовый документ', partners: [{ name: 'Тестовый партнёр', share_percent: 50 }, { name: 'Тестовый ТОЗОН', share_percent: 50 }], members: [{ user_id: 2, project_role: 'MANAGER' }], complex_ids: [3, 4], ...extra });
const save = (id, version, data = payload(), actor = 1) => db.query('SELECT public.save_company_project_draft($1,$2,$3::jsonb,$4) AS project', [id, version, JSON.stringify(data), actor]);
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE public.users(id integer PRIMARY KEY,role text,is_active integer);INSERT INTO users VALUES(1,'ADMIN',1),(2,'MANAGER',1),(3,'ADMIN',0);
    CREATE TABLE public.projects(id integer PRIMARY KEY,archived_at text,name text);INSERT INTO projects VALUES(3,null,'Тест Plaza'),(4,null,'Тест Plaza-2'),(5,'2026-01-01','Архив');
    CREATE TABLE public.payments(id integer PRIMARY KEY,amount_minor integer); INSERT INTO payments VALUES(100,123456);
    GRANT SELECT ON users,projects TO service_role;`);
  await db.exec(readFileSync(new URL('../../../supabase/migrations/20261110070710_company_project_registry.sql', import.meta.url), 'utf8'));
  const rows = (await db.query('SELECT id,code FROM company_projects')).rows;
  plaza = rows.find(p => p.code === 'TOZON_PLAZA').id; tower = rows.find(p => p.code === 'TOZON_TOWER').id;
});
afterAll(async () => db.close());
describe.sequential('company project preparation registry', () => {
  it('seeds the confirmed five projects without guessing partners or binding existing complexes', async () => {
    expect((await db.query('SELECT * FROM company_projects')).rows).toHaveLength(5);
    for (const table of ['company_project_partners', 'company_project_memberships', 'company_project_complexes']) expect((await db.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
  });
  it.each(['anon', 'authenticated'])('blocks direct reads, writes and RPC as %s', async role => {
    await db.exec(`SET ROLE ${role}`);
    try {
      for (const table of ['crm_companies', 'company_projects', 'company_project_partners', 'company_project_memberships', 'company_project_complexes', 'company_project_history']) {
        await expect(db.query(`SELECT * FROM public.${table}`)).rejects.toThrow();
        await expect(db.query(`DELETE FROM public.${table}`)).rejects.toThrow();
      }
      await expect(save(plaza, 1)).rejects.toThrow('permission denied');
    } finally { await db.exec('RESET ROLE'); }
  });
  it('saves partner shares, director and both complexes in one audited transaction', async () => {
    await db.exec('SET ROLE service_role');
    try {
      const result = (await save(plaza, 1)).rows[0].project;
      expect(result.revision).toBe(2); expect(result.isolation_state).toBe('PREPARATION');
      expect((await db.query('SELECT * FROM company_project_complexes')).rows).toHaveLength(2);
      expect((await db.query('SELECT * FROM company_project_memberships')).rows[0].access_state).toBe('PLANNED');
      expect((await db.query('SELECT * FROM company_project_history')).rows).toHaveLength(1);
    } finally { await db.exec('RESET ROLE'); }
  });
  it('rejects stale updates and invalid actors without modifying any data', async () => {
    const before = (await db.query('SELECT * FROM company_project_history')).rows;
    await expect(save(plaza, 1)).rejects.toThrow('STALE_PROJECT');
    await expect(save(plaza, 2, payload(), 2)).rejects.toThrow('ADMIN_REQUIRED');
    await expect(save(plaza, 2, payload(), 3)).rejects.toThrow('ADMIN_REQUIRED');
    expect((await db.query('SELECT * FROM company_project_history')).rows).toEqual(before);
  });
  it('rejects moving an assigned complex by rollback of the whole attempted save', async () => {
    await expect(save(tower, 1, payload({ name: 'Changed Tower', code: 'TOZON_TOWER' }))).rejects.toThrow('duplicate key');
    expect((await db.query('SELECT name,revision FROM company_projects WHERE id=$1', [tower])).rows[0]).toEqual({ name: 'Tozon Tower', revision: 1 });
    expect((await db.query('SELECT * FROM company_project_partners WHERE company_project_id=$1', [tower])).rows).toHaveLength(0);
  });
  it('rejects bad shares, repeated staff, inactive staff, unknown/archived complexes and activation', async () => {
    for (const bad of [
      { partners: [{ name: 'One', share_percent: 50 }] },
      { members: [{ user_id: 3, project_role: 'MANAGER' }] },
      { members: [{ user_id: 2, project_role: 'MANAGER' }, { user_id: 2, project_role: 'PARTNER' }] },
      { complex_ids: [999] }, { complex_ids: [5] }, { isolation_state: 'ACTIVE' },
    ]) await expect(save(plaza, 2, payload(bad))).rejects.toThrow();
    expect((await db.query('SELECT revision FROM company_projects WHERE id=$1', [plaza])).rows[0].revision).toBe(2);
    await expect(db.query("UPDATE company_projects SET isolation_state='ACTIVE' WHERE id=$1", [plaza])).rejects.toThrow();
    await expect(db.query("UPDATE company_project_memberships SET access_state='ACTIVE'")).rejects.toThrow();
  });
  it('preserves financial records and legacy users unchanged', async () => {
    expect((await db.query('SELECT * FROM payments')).rows).toEqual([{ id: 100, amount_minor: 123456 }]);
    expect((await db.query('SELECT * FROM users ORDER BY id')).rows).toEqual([{id:1,role:'ADMIN',is_active:1},{id:2,role:'MANAGER',is_active:1},{id:3,role:'ADMIN',is_active:0}]);
  });
});
