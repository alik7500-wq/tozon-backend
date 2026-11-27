import {beforeAll,afterAll,beforeEach,afterEach,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createWorkspaceFixture,cashA,cashB} from './workspace.fixture.js';
let db,plaza,tower;
const book=(actor=10,project=plaza,desk=null)=>db.query('select read_company_project_cash_book($1,$2,$3) as result',[actor,project,desk]).then(r=>r.rows[0].result);
async function denied(call,message){await db.exec('SAVEPOINT denial');try{await expect(call()).rejects.toThrow(message);}finally{await db.exec('ROLLBACK TO denial;RELEASE denial');}}
beforeAll(async()=>{
 ({db,plaza,tower}=await createWorkspaceFixture());
 await db.exec(`ALTER TABLE dictionaries ADD COLUMN name text DEFAULT 'Cash';ALTER TABLE dictionaries ADD COLUMN is_active boolean DEFAULT true;
 ALTER TABLE deals ADD COLUMN company_project_id uuid;
 ALTER TABLE payments ADD COLUMN voided_at timestamptz;ALTER TABLE payments ADD COLUMN method text DEFAULT 'CASH';ALTER TABLE payments ADD COLUMN settlement_method text DEFAULT 'CASH';ALTER TABLE payments ADD COLUMN operation_type text DEFAULT 'STANDARD';ALTER TABLE payments ADD COLUMN transfer_id uuid;ALTER TABLE payments ADD COLUMN conversion_id uuid;
 ALTER TABLE expenses ADD COLUMN voided_at timestamptz;ALTER TABLE expenses ADD COLUMN method text DEFAULT 'CASH';ALTER TABLE expenses ADD COLUMN settlement_method text DEFAULT 'CASH';ALTER TABLE expenses ADD COLUMN operation_type text DEFAULT 'STANDARD';ALTER TABLE expenses ADD COLUMN transfer_id uuid;ALTER TABLE expenses ADD COLUMN conversion_id uuid;
 CREATE TABLE barter_realization_results(status text,reclassified_payment_id integer,reclassified_expense_id integer);GRANT SELECT ON barter_realization_results TO service_role;
 DELETE FROM payments WHERE id=3;DELETE FROM expenses WHERE id=3;`);
 await db.exec(readFileSync(new URL('../../../supabase/migrations/20261116101424_company_project_cash_book.sql',import.meta.url),'utf8'));
},30000);
afterAll(()=>db?.close());beforeEach(()=>db.exec('BEGIN'));afterEach(()=>db.exec('ROLLBACK'));
it('returns only the selected project cash desk and exact currency totals without personal data',async()=>{
 await db.exec(`INSERT INTO payments(id,cash_desk_id,amount_minor,currency,payment_date,status) VALUES(10,'${cashA}',12345,'TJS','2026-11-02','POSTED');UPDATE expenses SET amount_minor=25 WHERE id=1;`);
 const r=await book();expect(r.records).toHaveLength(3);expect(r.totals).toEqual([{currency:'TJS',income:'123.45',expense:'0.00',balance:'123.45'},{currency:'USD',income:'1.00',expense:'0.25',balance:'0.75'}]);
 expect(r.records[0]).toMatchObject({id:10,kind:'INCOME',amount:'123.45'});expect(JSON.stringify(r)).not.toMatch(/Tower|PRIVATE|full_name|contract_number/);expect(JSON.stringify(r)).not.toContain(cashB);
});
it('requires both fresh grants, enabled roster and project membership even for admins',async()=>{
 await denied(()=>book(10,tower),'WORKSPACE_ACCESS_DENIED');await denied(()=>book(30),'WORKSPACE_ACCESS_DENIED');await denied(()=>book(10,plaza,cashB),'WORKSPACE_RECORD_NOT_FOUND');
 for(const sections of [['finance.payments'],['finance.expenses']]){await db.query('UPDATE company_workspace_access SET sections=$1 WHERE user_id=10',[sections]);await denied(()=>book(),'WORKSPACE_ACCESS_DENIED');}
 await db.exec("UPDATE company_workspace_access SET sections=ARRAY['finance.payments','finance.expenses'];UPDATE company_workspace_users SET enabled=false WHERE user_id=10");await denied(()=>book(),'WORKSPACE_ACCESS_DENIED');
});
it('refuses any contradictory deal, lead, unit or explicit project link instead of hiding a partial history',async()=>{
 await db.exec('UPDATE payments SET deal_id=2 WHERE id=1');await denied(()=>book(),'WORKSPACE_CASH_SCOPE_CONFLICT');
 await db.exec('UPDATE payments SET deal_id=1 WHERE id=1');await db.query('UPDATE deals SET company_project_id=$1 WHERE id=1',[tower]);await denied(()=>book(),'WORKSPACE_CASH_SCOPE_CONFLICT');
 await db.exec('UPDATE deals SET company_project_id=NULL,lead_id=2 WHERE id=1');await denied(()=>book(),'WORKSPACE_CASH_SCOPE_CONFLICT');
});
it('retains archived inventory and inactive desk history',async()=>{
 await db.exec('UPDATE dictionaries SET is_active=false;UPDATE units SET archived_at=now()::text');expect((await book()).cash_desks[0].active).toBe(false);expect((await book()).totals[0].balance).toBe('0.00');
});
it('shows voided records but excludes them from every total, including legacy voided_at',async()=>{
 await db.exec("UPDATE payments SET voided_at=now() WHERE id=1;UPDATE expenses SET status='VOIDED' WHERE id=1");const r=await book();expect(r.records).toHaveLength(2);expect(r.records.every(x=>!x.active)).toBe(true);expect(r.totals).toEqual([]);
});
it('withholds balances for FX, transfers, ambiguous legacy cash, bank and barter rather than mixing them',async()=>{
 for(const assignment of ["operation_type='CONVERSION'","transfer_id=gen_random_uuid()","conversion_id=gen_random_uuid()","settlement_method=NULL","settlement_method='BANK'","settlement_method='NON_CASH_BARTER'","method='BANK'","status='DRAFT'","amount_minor=-1","currency=NULL"]){
  await db.exec('SAVEPOINT special');await db.exec('UPDATE payments SET '+assignment+' WHERE id=1');const r=await book();expect(r.requires_review,assignment).toBe(true);expect(r.totals).toBeNull();expect(r.records).toHaveLength(2);await db.exec('ROLLBACK TO special;RELEASE special');
 }
 await db.exec("INSERT INTO barter_realization_results VALUES('ACTIVE',1,NULL)");expect((await book()).requires_review).toBe(true);
});
it('returns a genuine empty book and never invents opening balances',async()=>{
 await db.exec('DELETE FROM payments;DELETE FROM expenses');expect(await book()).toMatchObject({records:[],totals:[],requires_review:false});await db.exec('DELETE FROM company_project_cash_desks');expect(await book()).toMatchObject({selected_cash_desk_id:null,cash_desks:[],records:[]});
});
it('sums the whole history beyond a visible page without JS money arithmetic',async()=>{
 await db.exec(`INSERT INTO payments(id,cash_desk_id,amount_minor,currency,payment_date,status) SELECT 100+n,'${cashA}',2147483647,'USD','2026-11-02','ACTIVE' FROM generate_series(1,150) n`);
 const r=await book();expect(r.records).toHaveLength(152);expect(r.totals[0].balance).toBe('3221225470.50');
});
it('refuses oversized books instead of silently truncating',async()=>{
 await db.exec(`INSERT INTO payments(id,cash_desk_id,amount_minor,currency,payment_date,status) SELECT 100+n,'${cashA}',1,'USD','2026-11-02','ACTIVE' FROM generate_series(1,5000) n`);await expect(book()).rejects.toThrow('WORKSPACE_CASH_TOO_LARGE');
});
it('is read only, service-only and inaccessible directly from browser roles',async()=>{
 const before=await db.query('select * from payments order by id');await db.exec('SET ROLE service_role');await book();await db.exec('RESET ROLE');expect(await db.query('select * from payments order by id')).toEqual(before);
 await db.exec('SET ROLE authenticated');await expect(book()).rejects.toThrow();
});
