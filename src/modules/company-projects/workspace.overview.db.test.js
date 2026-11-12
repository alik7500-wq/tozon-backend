import {beforeAll,afterAll,beforeEach,afterEach,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createWorkspaceFixture} from './workspace.fixture.js';
let db,plaza,tower;
const overview=(actor=10,project=plaza)=>db.query('select read_company_project_overview($1,$2) as result',[actor,project]).then(r=>r.rows[0].result);
beforeAll(async()=>{
 ({db,plaza,tower}=await createWorkspaceFixture());
 await db.exec('ALTER TABLE deals ADD COLUMN company_project_id uuid');
 await db.query('UPDATE deals SET company_project_id=CASE WHEN id=1 THEN $1::uuid ELSE $2::uuid END',[plaza,tower]);
 await db.exec("UPDATE deal_payment_schedules SET due_date=((now() AT TIME ZONE 'Asia/Dushanbe')::date+1)::text");
 await db.exec(readFileSync(new URL('../../../supabase/migrations/20261112182809_company_project_overview.sql',import.meta.url),'utf8'));
},30000);
afterAll(()=>db?.close());beforeEach(()=>db.exec('BEGIN'));afterEach(()=>db.exec('ROLLBACK'));
it('returns only own project counts and future unpaid schedule without passport fields',async()=>{
 const r=await overview();expect(r.inventory).toEqual({apartments:1,available:0,reserved:0,sold:1});expect(r.signed_contracts).toBe(1);expect(r.active_leads).toBe(0);expect(r.upcoming_payments).toHaveLength(1);expect(r.upcoming_payments[0]).toMatchObject({contract_number:'A-CONTRACT',client_name:'Plaza Client',remaining_minor:1000});expect(JSON.stringify(r)).not.toMatch(/Tower|PRIVATE|MISMATCH/);
});
it('counts all apartments beyond the record page limit and excludes archives and non-apartments',async()=>{
 await db.exec("INSERT INTO units SELECT n,1,n::text,6000,70000,'AVAILABLE','APARTMENT',null FROM generate_series(10,159)n;INSERT INTO units VALUES(160,1,'archived',6000,1,'AVAILABLE','APARTMENT','archived'),(161,1,'shop',6000,1,'AVAILABLE','COMMERCIAL',null)");
 expect((await overview()).inventory).toEqual({apartments:151,available:150,reserved:0,sold:1});
});
it('counts only active own leads without signed contracts',async()=>{
 await db.exec("INSERT INTO leads VALUES(10,'Active A','100','NEW',null,null),(11,'Foreign B','200','NEW',null,null),(12,'Archived A','300','NEW',null,'archived'),(13,'Lost A','400','LOST',null,null)");
 await db.query('INSERT INTO company_project_leads VALUES(10,$1),(11,$2),(12,$1),(13,$1)',[plaza,tower]);expect((await overview()).active_leads).toBe(1);
});
it('hides metrics and contact names when corresponding read grants are removed',async()=>{
 await db.exec("UPDATE company_workspace_access SET sections=ARRAY['deals.view','finance.payments'] WHERE user_id=10");const r=await overview();expect(r.inventory).toBeNull();expect(r.active_leads).toBeNull();expect(r.upcoming_payments[0].client_name).toBeNull();
 await db.exec("UPDATE company_workspace_access SET sections=ARRAY['inventory.view'] WHERE user_id=10");const limited=await overview();expect(limited.signed_contracts).toBeNull();expect(limited.upcoming_payments).toBeNull();
});
it('excludes overdue, paid, cancelled and unsigned schedules and limits ordered future rows',async()=>{
 await db.exec("UPDATE deal_payment_schedules SET due_date='2000-01-01' WHERE id=1;INSERT INTO deal_payment_schedules VALUES(10,1,'2099-01-01',100,100,'PAID'),(11,1,'2099-01-01',100,0,'CANCELLED');INSERT INTO deal_payment_schedules SELECT n,1,'2099-02-01',100,0,'UPCOMING' FROM generate_series(20,28)n");
 const r=await overview();expect(r.upcoming_payments.map(p=>p.id)).toEqual([20,21,22,23,24]);
});
it('rejects foreign projects, global admin identities and current access revocation',async()=>{
 await expect(overview(10,tower)).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
});
it('does not grant direct browser-role access to the overview function',async()=>{await db.exec('SET ROLE authenticated');await expect(overview()).rejects.toThrow();});
it('rechecks active access instead of trusting earlier context',async()=>{await db.exec('UPDATE company_workspace_access SET enabled=false WHERE user_id=10');await expect(overview()).rejects.toThrow('WORKSPACE_ACCESS_DENIED');});

it('does not let a global admin identity bypass project membership',async()=>{await expect(overview(30,plaza)).rejects.toThrow('WORKSPACE_ACCESS_DENIED');});
