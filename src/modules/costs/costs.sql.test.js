import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
let db;
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const basis = (building = 3, area = 200, version = 0) => q("select cost_save_basis($1,$2,'Project schedule',$3,1) as data", [building, area, version]);
const allocate = (mode = 'DIRECT', ids = [3], version = 0, actor = 1) => q("select cost_save_allocation(1,$1,$2,'Invoice materials',$3,$4) as data", [mode, ids, version, actor]);
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table users(id integer primary key,role text,is_active integer,permissions jsonb);
    create table buildings(id integer primary key,project_id integer,archived_at text);
    create table expenses(id integer primary key,amount_minor integer,currency text,expense_date date,category text,operation_type text,transfer_id uuid,conversion_id uuid,conversion_expense_id integer,status text,voided_at timestamptz);
    create table construction_documents(id integer primary key,expense_id integer,kind text,status text);
    insert into users values(1,'ADMIN',1,'[]'),(2,'FINANCE_MANAGER',1,'["finance.expenses"]'),(3,'FINANCE_MANAGER',1,'["finance.costs","finance.costs.write"]'),(4,'ADMIN',0,'[]');
    insert into buildings values(3,3,null),(4,3,null),(5,9,null),(6,3,'2026-10-01');`);
  await db.exec(readFileSync(new URL('../../../supabase/migrations/20261018084531_block_cost_accounting.sql', import.meta.url), 'utf8'));
}, 20000);
beforeEach(async () => {
  await db.exec(`truncate cost_expense_allocations,cost_building_bases,cost_audit,construction_documents,expenses;
    insert into expenses(id,amount_minor,currency,expense_date,category,status,operation_type) values(1,10001,'USD','2026-10-01','Materials','ACTIVE','STANDARD');`);
});
afterAll(async () => db?.close());
describe('Cost allocation PostgreSQL transactions', () => {
  it('saves direct assignment and audit without touching the RKO amount', async () => {
    const before = await q('select * from expenses'); await allocate();
    expect(await q('select * from expenses')).toEqual(before);
    expect((await q('select * from cost_audit')).length).toBe(1);
  });
  it('requires confirmed area for shared expenditure', async () => {
    await basis(); await expect(allocate('SHARED', [3, 4])).rejects.toThrow('подтвердите');
    await basis(4, 100); const r = await allocate('SHARED', [3, 4]);
    expect(r[0].data.shares.map(s => s.weight)).toEqual([200, 100]);
  });
  it('keeps old shared weights when the denominator changes', async () => {
    await basis(); await basis(4, 100); await allocate('SHARED', [3, 4]); await basis(3, 300, 1);
    expect((await q('select shares from cost_expense_allocations'))[0].shares[0].weight).toBe(200);
  });
  it('rejects stale writes atomically', async () => {
    await allocate(); await expect(allocate()).rejects.toThrow('VERSION_CONFLICT');
    expect((await q('select count(*)::int as n from cost_audit'))[0].n).toBe(1);
    await basis(); await expect(basis(3, 300)).rejects.toThrow('VERSION_CONFLICT');
  });
  it.each([['DIRECT', []], ['DIRECT', [3, 4]], ['SHARED', [3, 3]], ['SHARED', [3, 5]], ['DIRECT', [6]], ['DIRECT', [99]], ['EXCLUDED', [3]]])('rejects invalid block selection %s %j', async (mode, ids) => {
    await expect(allocate(mode, ids)).rejects.toThrow(); expect(await q('select * from cost_expense_allocations')).toEqual([]);
  });
  it.each([2, 4])('rejects actor without permission or inactive actor %s', async actor => { await expect(allocate('DIRECT', [3], 0, actor)).rejects.toThrow('COST_ACCESS_DENIED'); });
  it('accepts explicitly delegated cost writer', async () => { expect((await allocate('DIRECT', [3], 0, 3))[0].data.updated_by).toBe(3); });
  it('rejects transfers, conversion legs, voided RKO and posted advances', async () => {
    for (const patch of ["operation_type='CONVERSION'", "status='VOIDED'", "category='Конвертация валюты'"]) {
      await db.exec(`update expenses set ${patch}`); await expect(allocate()).rejects.toThrow('не включаются');
      await db.exec("update expenses set operation_type='STANDARD',status='ACTIVE',category='Materials'");
    }
    await db.exec("insert into construction_documents values(1,1,'ADVANCE_ISSUE','POSTED')");
    await expect(allocate()).rejects.toThrow('не включаются');
  });
  it('deleting a source removes only its allocation, preserving historical audit', async () => {
    await allocate(); await db.exec('delete from expenses where id=1');
    expect(await q('select * from cost_expense_allocations')).toEqual([]); expect((await q('select * from cost_audit')).length).toBe(1);
  });
  it('public roles cannot read private analytics or call privileged RPC', async () => {
    const rights = (await q(`select has_table_privilege('anon','cost_audit','SELECT') as a,
      has_table_privilege('authenticated','cost_building_bases','SELECT') as b,
      has_function_privilege('anon','cost_save_allocation(integer,text,integer[],text,integer,integer)','EXECUTE') as c,
      has_function_privilege('service_role','cost_save_allocation(integer,text,integer[],text,integer,integer)','EXECUTE') as d`))[0];
    expect(rights).toEqual({ a: false, b: false, c: false, d: true });
    expect((await q("select count(*)::int as n from pg_class where relname in ('cost_audit','cost_building_bases','cost_expense_allocations') and relrowsecurity"))[0].n).toBe(3);
  });
});
