import {describe,it,expect,beforeAll,afterAll,beforeEach} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
let db;const stamp='2026-10-01T00:00:00Z';
const call=(extra={},actor=1)=>db.query('select correct_installment_term_atomic(1,$1,$2::jsonb)',[actor,JSON.stringify({installment_months:30,expected_updated_at:stamp,deal_date:'2026-09-15',...extra})]);
const rows=t=>db.query(`select * from ${t} order by id`).then(r=>r.rows);
beforeAll(async()=>{db=new PGlite();await db.exec(`
CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
CREATE TABLE users(id int primary key,role text,is_active int);
CREATE TABLE leads(id int primary key,full_name text,phone text,passport_series text,passport_number text,inn text,updated_at text);
CREATE TABLE deals(id int primary key,lead_id int,deal_date text,contract_number text,status text,payment_type text,currency text,installment_months int,
base_price_minor int,discount_minor int,final_price_minor int,deal_price_per_m2_minor int,down_payment_minor int,exchange_rate numeric,
responsible_user_id int,reservation_expires_at text,barter_description text,barter_amount_minor int,created_at text,updated_at text);
CREATE TABLE deal_payment_schedules(id serial primary key,deal_id int references deals(id),payment_number int,due_date text,amount_minor int,paid_amount_minor int,status text,created_at text,updated_at text);
CREATE TABLE payments(id int primary key,deal_id int references deals(id),schedule_id int references deal_payment_schedules(id) on delete set null,amount_minor int,status text,currency text);
INSERT INTO users VALUES(1,'ADMIN',1),(2,'FINANCE_MANAGER',1),(3,'ADMIN',0);
INSERT INTO leads VALUES(1,'Test buyer','test',null,null,null,null);
`);await db.exec(readFileSync(new URL('../../../db/migrations/020_add_deal_audit_log_and_atomic_update.sql',import.meta.url),'utf8'));await db.exec(readFileSync(new URL('../../../db/migrations/20261014113000_correct_installment_term.sql',import.meta.url),'utf8'));});
afterAll(async()=>db.close());
beforeEach(async()=>{await db.exec(`TRUNCATE payments,deal_payment_schedules,deal_audit_logs,deals CASCADE;
INSERT INTO deals(id,lead_id,deal_date,contract_number,status,payment_type,currency,installment_months,final_price_minor,down_payment_minor,created_at,updated_at) VALUES(1,1,'2026-09-15','0027','SIGNED','INSTALLMENT','USD',24,3858300,420712,'2026-09-15','${stamp}');
INSERT INTO deal_payment_schedules(deal_id,payment_number,due_date,amount_minor,paid_amount_minor,status) SELECT 1,i,'2026-10-15',143232,0,'UPCOMING' FROM generate_series(1,24) i;
INSERT INTO payments VALUES(1,1,(select min(id) from deal_payment_schedules),420712,'ACTIVE','USD'),(2,1,null,100000,'VOIDED','USD');`);});
describe('installment term correction (synthetic PostgreSQL)',()=>{
it('24 to 30 preserves receipts, existing schedule IDs and exact contract balance',async()=>{const p=await rows('payments'),s=await rows('deal_payment_schedules');await call();const d=(await rows('deals'))[0],n=await rows('deal_payment_schedules');expect(d.installment_months).toBe(30);expect(d.final_price_minor).toBe(3858300);expect(d.down_payment_minor).toBe(420712);expect(await rows('payments')).toEqual(p);expect(n.slice(0,24).map(x=>x.id)).toEqual(s.map(x=>x.id));expect(n).toHaveLength(30);expect(n.reduce((t,x)=>t+x.amount_minor,0)).toBe(3437588);expect(n[0].due_date).toBe('2026-10-15');expect(n[29].due_date).toBe('2029-03-15');expect(n.reduce((t,x)=>t+x.paid_amount_minor,0)).toBe(0);});
it('reallocates paid installments FIFO without changing payments',async()=>{await db.exec('update payments set amount_minor=720712 where id=1');const before=await rows('payments');await call();expect(await rows('payments')).toEqual(before);expect((await rows('deal_payment_schedules')).reduce((t,x)=>t+x.paid_amount_minor,0)).toBe(300000);});
it('clamps month-end dates',async()=>{await db.exec("update deals set deal_date='2026-01-31'");await call({deal_date:'2026-01-31'});expect((await rows('deal_payment_schedules'))[0].due_date).toBe('2026-02-28');});
it.each([0,61])('rejects invalid term %s',async(n)=>{await expect(call({installment_months:n})).rejects.toThrow();expect((await rows('deals'))[0].installment_months).toBe(24);});
it.each([2,3])('rejects unauthorized actor %s',async(a)=>{await expect(call({},a)).rejects.toThrow();});
it('rejects stale saves and locked financial fields',async()=>{await expect(call({expected_updated_at:'2026-01-01'})).rejects.toThrow('STALE_DEAL');await expect(call({final_price_minor:100})).rejects.toThrow();});
it('rolls back the entire correction if audit fails',async()=>{await db.exec("create function fail_audit() returns trigger language plpgsql as $$ begin raise exception 'audit fail'; end $$;create trigger fail before insert on deal_audit_logs for each row execute function fail_audit()");await expect(call()).rejects.toThrow('audit fail');expect((await rows('deals'))[0].installment_months).toBe(24);expect(await rows('deal_payment_schedules')).toHaveLength(24);await db.exec('drop trigger fail on deal_audit_logs');});
});
