import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

it('records a historical date, replays duplicates and protects approved cases and public roles', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE users (id integer PRIMARY KEY, is_active integer, role text);
      CREATE TABLE resettlement_cases (id bigint PRIMARY KEY, status text);
      INSERT INTO users VALUES (1,1,'ADMIN'), (2,1,'DIRECTOR');
      INSERT INTO resettlement_cases VALUES (7,'DRAFT'), (8,'APPROVED');
      GRANT SELECT ON users TO service_role;
      GRANT SELECT, UPDATE ON resettlement_cases TO service_role;
    `);
    await db.exec(await readFile(
      new URL('../../../../supabase/migrations/20261127100000_resettlement_agreements.sql', import.meta.url),
      'utf8'
    ));
    const register = (caseId, actor, kind = 'PRIMARY', number = '5', notes = '') => db.query(
      'SELECT * FROM record_resettlement_agreement($1,$2,$3,$4,$5,$6,$7,$8)',
      [caseId, actor, kind, number, '2026-05-07', 'Контора', 'Переселение', notes]
    );
    await db.exec('SET ROLE service_role');
    await expect(register(7, 2)).rejects.toThrow('INVALID_ACTOR');
    await expect(register(8, 1)).rejects.toThrow('RESETTLEMENT_NOT_DRAFT');
    await expect(register(7, 1, 'ADDENDUM', '6')).rejects.toThrow('PRIMARY_AGREEMENT_REQUIRED');
    const original = await register(7, 1);
    expect(original.rows[0]).toMatchObject({
      kind: 'PRIMARY', signed_on: new Date('2026-05-07T00:00:00Z'), recorded_by: 1
    });
    await expect(register(7, 1)).resolves.toMatchObject({ rows: original.rows });
    await expect(register(7, 1, 'PRIMARY', '5', 'другие условия')).rejects.toThrow('AGREEMENT_CONFLICT');
    await expect(register(7, 1, 'ADDENDUM', '6')).resolves.toMatchObject({ rows: [{ kind: 'ADDENDUM' }] });
    await db.exec('RESET ROLE; SET ROLE anon');
    await expect(register(7, 1)).rejects.toThrow('permission denied');
    await expect(db.query('SELECT * FROM resettlement_agreements')).rejects.toThrow('permission denied');
  } finally {
    await db.close();
  }
}, 15000);
