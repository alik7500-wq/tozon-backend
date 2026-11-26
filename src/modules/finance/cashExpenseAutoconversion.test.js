import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

const db = new PGlite();
const migration = new URL('../../../supabase/migrations/20261126120000_void_cash_expense_autoconversion.sql', import.meta.url);
const fx = '11111111-1111-1111-1111-111111111111';
const desk = '22222222-2222-2222-2222-222222222222';
const voidOrder = (id = 2, actor = 1) => db.query('select public.void_cash_expense_autoconversion($1, $2) as result', [id, actor]);
const states = async () => (await db.query(`select id,status,voided_by from expenses
  union all select id,status,voided_by from payments order by id`)).rows;

beforeAll(async () => {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table users(id int primary key, role text, is_active int);
    insert into users values (1,'ADMIN',1),(2,'MANAGER',1);
    create table expenses(id int primary key, cash_desk_id uuid, conversion_id uuid, conversion_expense_id int,
      transfer_id uuid, status text, voided_at timestamptz, void_reason text, voided_by int, operation_type text,
      settlement_updated_by int, settlement_party_id uuid, category text, currency text, amount_minor int);
    create table payments(id int primary key, cash_desk_id uuid, conversion_id uuid, deal_id int,
      transfer_id uuid, status text, voided_at timestamptz, void_reason text, voided_by int, operation_type text,
      currency text, amount_minor int);
  `);
  await db.exec(readFileSync(migration, 'utf8'));
});
beforeEach(async () => {
  await db.exec(`
    drop trigger if exists block_payment_void on payments;
    truncate expenses, payments;
    insert into expenses(id,cash_desk_id,conversion_id,conversion_expense_id,status,operation_type,category,currency,amount_minor)
    values (1,'${desk}','${fx}',null,'ACTIVE','CONVERSION','Конвертация валюты','USD',1079),
           (2,'${desk}','${fx}',1,'ACTIVE','STANDARD','Прочее','TJS',10000),
           (4,'${desk}',null,null,'ACTIVE','STANDARD','Прочее','USD',1000);
    insert into payments(id,cash_desk_id,conversion_id,status,operation_type,currency,amount_minor)
    values (3,'${desk}','${fx}','ACTIVE','CONVERSION','TJS',10000);
  `);
});
afterAll(() => db.close());

it('annuls exactly the three linked orders and can retry without altering them', async () => {
  const { rows } = await voidOrder();
  expect(rows[0].result).toMatchObject({ expense_id: 2, conversion_expense_id: 1, conversion_payment_id: 3 });
  const saved = await states();
  expect(saved).toEqual([1,2,3].map(id => ({ id, status: 'VOIDED', voided_by: 1 }))
    .concat({ id: 4, status: 'ACTIVE', voided_by: null }));
  expect((await voidOrder()).rows[0].result.idempotent).toBe(true);
  expect(await states()).toEqual(saved);
});

it('rejects one leg, non-admin users and ambiguous links', async () => {
  await expect(voidOrder(1)).rejects.toThrow(/однозначно/);
  await expect(voidOrder(2, 2)).rejects.toThrow(/только администратору/);
  await db.exec("insert into payments select 5,cash_desk_id,conversion_id,deal_id,transfer_id,status,voided_at,void_reason,voided_by,operation_type,currency,amount_minor from payments where id=3");
  await expect(voidOrder()).rejects.toThrow(/однозначно/);
  expect((await states()).every(row => row.status === 'ACTIVE')).toBe(true);
});

it('rolls back both expense updates if the linked payment cannot be annulled', async () => {
  await db.exec(`create function deny_payment_void() returns trigger language plpgsql as
    $$ begin raise exception 'payment locked'; end; $$;
    create trigger block_payment_void before update on payments for each row execute function deny_payment_void();`);
  await expect(voidOrder()).rejects.toThrow(/payment locked/);
  expect((await states()).every(row => row.status === 'ACTIVE')).toBe(true);
});
