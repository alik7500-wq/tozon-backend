import { describe,it,expect,beforeAll,afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
let db;
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE payments(id serial PRIMARY KEY,deal_id int,reference text,document_number text,
      operation_type text DEFAULT 'STANDARD',settlement_method text DEFAULT 'CASH',
      transfer_id uuid,conversion_id uuid,status text DEFAULT 'ACTIVE',voided_at text,
      currency text DEFAULT 'USD',amount_minor int DEFAULT 10000,idempotency_key text UNIQUE);
    INSERT INTO payments(id,deal_id,reference) VALUES(30,1,'ПКО-9503'),(520,1,'ПКО-94'),(521,1,'ПКО-95'),(522,2,'ПКО-96'),(524,3,'ПКО-97');
    CREATE FUNCTION generic_number() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.document_number:='GEN-'||NEW.id;RETURN NEW;END $$;
    CREATE TRIGGER crm_payment_number BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION generic_number();`);
  await db.exec(readFileSync(new URL('../../../supabase/migrations/20261019110144_customer_pko_book.sql',import.meta.url),'utf8'));
});
afterAll(async()=>db.close());
describe.sequential('customer PKO transactional book',()=>{
  it('preserves all existing documents and seeds the last issued series rather than an unrelated historic range',async()=>{
    expect((await db.query('select last_number from tozon_internal.customer_pko_counter')).rows[0].last_number).toBe(97);
    expect((await db.query('select reference,document_number,customer_pko_number from payments where id=524')).rows[0]).toEqual({reference:'ПКО-97',document_number:null,customer_pko_number:null});
  });
  it('assigns 98 and 99 across currencies, ignores a manually supplied number and overrides generic template',async()=>{
    const a=(await db.query(`insert into payments(deal_id,reference,currency) values(1,'ПКО-КОНВ-arbitrary','TJS') returning *`)).rows[0];
    const b=(await db.query(`insert into payments(deal_id,currency) values(2,'USD') returning *`)).rows[0];
    expect([a.customer_pko_number,b.customer_pko_number]).toEqual([98,99]);expect(a.reference).toBe('ПКО-98');expect(a.document_number).toBe('ПКО-98');
  });
  it('keeps transfers, conversions, investments, barter and direct income out of the buyer series',async()=>{
    for(const values of ["null,'STANDARD','CASH','ПКО-ПЕРЕМ-1'","null,'CONVERSION','CONVERSION','ПКО-КОНВ-1'","null,'INVESTMENT','CASH','INV-1'","1,'STANDARD','NON_CASH_BARTER','BARTER'","null,'STANDARD','CASH','DIRECT'"]){
      const p=(await db.query(`insert into payments(deal_id,operation_type,settlement_method,reference) values(${values}) returning *`)).rows[0];
      expect(p.customer_pko_number).toBeNull();expect(p.document_number).toBe('GEN-'+p.id);
    }
    expect((await db.query('select last_number from tozon_internal.customer_pko_counter')).rows[0].last_number).toBe(99);
  });
  it('does not consume a buyer number if the payment transaction rolls back',async()=>{
    await db.exec('BEGIN');await db.query(`insert into payments(deal_id) values(1)`);await db.exec('ROLLBACK');
    expect((await db.query(`insert into payments(deal_id) values(1) returning reference`)).rows[0].reference).toBe('ПКО-100');
  });
  it('rolls numbering back together with a rejected duplicate payment',async()=>{
    await db.query(`insert into payments(deal_id,idempotency_key) values(1,'same-payment')`);
    await expect(db.query(`insert into payments(deal_id,idempotency_key) values(1,'same-payment')`)).rejects.toThrow();
    expect((await db.query(`insert into payments(deal_id) values(1) returning reference`)).rows[0].reference).toBe('ПКО-102');
  });
  it('preserves numbers on edits and voiding, blocks renumbering and physical deletion',async()=>{
    await db.query(`update payments set amount_minor=12000,status='VOIDED',voided_at='2026-10-19' where reference='ПКО-98'`);
    await expect(db.query(`update payments set reference='ПКО-1' where reference='ПКО-98'`)).rejects.toThrow('CUSTOMER_PKO_NUMBER_IMMUTABLE');
    await expect(db.query(`delete from payments where reference='ПКО-98'`)).rejects.toThrow('CUSTOMER_PKO_MUST_BE_VOIDED');
    await expect(db.query(`update payments set deal_id=null where reference='ПКО-97'`)).rejects.toThrow('CUSTOMER_PKO_NUMBER_IMMUTABLE');
  });
  it('skips a previously issued legacy number without overwriting it',async()=>{
    await db.query(`insert into payments(reference) values('ПКО-103')`);
    expect((await db.query(`insert into payments(deal_id) values(1) returning reference`)).rows[0].reference).toBe('ПКО-104');
  });
  it('allocates unique consecutive numbers for queued simultaneous requests',async()=>{
    const rows=await Promise.all(Array.from({length:12},()=>db.query(`insert into payments(deal_id) values(1) returning customer_pko_number`)));
    const nums=rows.map(r=>r.rows[0].customer_pko_number);expect(new Set(nums).size).toBe(12);expect(Math.max(...nums)-Math.min(...nums)).toBe(11);
  });
  it('does not expose the counter or trigger via public roles',async()=>{
    await db.exec('SET ROLE anon');
    try { await expect(db.query('select * from tozon_internal.customer_pko_counter')).rejects.toThrow(); }
    finally { await db.exec('RESET ROLE'); }
    expect((await db.query(`select has_function_privilege('anon','tozon_internal.assign_customer_pko_number()','execute') as allowed`)).rows[0].allowed).toBe(false);
  });
});
