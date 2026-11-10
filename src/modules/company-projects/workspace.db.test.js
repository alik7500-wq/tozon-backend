import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
let db, plaza, tower;
const cashA='00000000-0000-4000-8000-000000000001',cashB='00000000-0000-4000-8000-000000000002';
const read = (actor,project,resource,record=null,after='',limit=50) => db.query('SELECT public.read_company_project_workspace($1,$2,$3,$4,$5,$6) AS result',[actor,project,resource,record,after,limit]);
beforeAll(async()=>{
 db=new PGlite();
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
 CREATE TABLE users(id integer PRIMARY KEY,role text,is_active integer,permissions jsonb);INSERT INTO users VALUES(10,'ADMIN',1,'["company.project-only"]'),(20,'MANAGER',1,'["company.project-only"]'),(30,'ADMIN',1,'[]');
 CREATE TABLE projects(id integer PRIMARY KEY,code text,name text,address text,archived_at text);INSERT INTO projects VALUES(1,'A','Plaza complex','A address',null),(2,'B','Tower complex','B address',null);
 CREATE TABLE buildings(id integer PRIMARY KEY,project_id integer,archived_at text);INSERT INTO buildings VALUES(1,1,null),(2,2,null);
 CREATE TABLE sections(id integer PRIMARY KEY,building_id integer,archived_at text);INSERT INTO sections VALUES(1,1,null),(2,2,null);
 CREATE TABLE floors(id integer PRIMARY KEY,section_id integer,archived_at text);INSERT INTO floors VALUES(1,1,null),(2,2,null);
 CREATE TABLE units(id integer PRIMARY KEY,floor_id integer,unit_number text,area_m2_x100 integer,price_per_m2_minor integer,status text,unit_kind text,archived_at text);INSERT INTO units VALUES(1,1,'A1',6000,70000,'SOLD','APARTMENT',null),(2,2,'B2',8000,60000,'SOLD','APARTMENT',null);
 CREATE TABLE leads(id integer PRIMARY KEY,full_name text,phone text,status text,passport_number text,archived_at text);INSERT INTO leads VALUES(1,'Plaza Client','111','WON','PRIVATE-A',null),(2,'Tower Client','222','WON','PRIVATE-B',null);
 CREATE TABLE deals(id integer PRIMARY KEY,unit_id integer,lead_id integer,contract_number text,status text,currency text,final_price_minor integer,down_payment_minor integer,deal_date text);INSERT INTO deals VALUES(1,1,1,'A-CONTRACT','SIGNED','USD',4200000,0,'2026-11-01'),(2,2,2,'B-CONTRACT','SIGNED','USD',4800000,0,'2026-11-01'),(3,1,2,'MISMATCH','SIGNED','USD',999,0,'2026-11-01');
 CREATE TABLE dictionaries(id uuid PRIMARY KEY,type text);INSERT INTO dictionaries VALUES('${cashA}','CASH_DESK'),('${cashB}','CASH_DESK');
 CREATE TABLE payments(id integer PRIMARY KEY,deal_id integer,cash_desk_id uuid,amount_minor integer,currency text,payment_date text,status text);INSERT INTO payments VALUES(1,1,'${cashA}',100,'USD','2026-11-01','ACTIVE'),(2,2,'${cashB}',200,'USD','2026-11-01','ACTIVE'),(3,2,'${cashA}',300,'USD','2026-11-01','ACTIVE');
 CREATE TABLE expenses(id integer PRIMARY KEY,deal_id integer,cash_desk_id uuid,amount_minor integer,currency text,expense_date text,category text,status text);INSERT INTO expenses VALUES(1,null,'${cashA}',100,'USD','2026-11-01','A expense','ACTIVE'),(2,null,'${cashB}',200,'USD','2026-11-01','B expense','ACTIVE'),(3,2,'${cashA}',999,'USD','2026-11-01','MISMATCH','ACTIVE');
 CREATE TABLE deal_payment_schedules(id integer PRIMARY KEY,deal_id integer,due_date text,amount_minor integer,paid_amount_minor integer,status text);INSERT INTO deal_payment_schedules VALUES(1,1,'2026-12-01',1000,0,'UPCOMING'),(2,2,'2026-12-01',2000,0,'UPCOMING');
 CREATE TABLE construction_warehouses(id uuid PRIMARY KEY,name text,active boolean);INSERT INTO construction_warehouses VALUES('${cashA}','A Warehouse',true),('${cashB}','B Warehouse',true);
 GRANT SELECT ON users,projects,buildings,sections,floors,units,leads,deals,payments,expenses,deal_payment_schedules,dictionaries,construction_warehouses TO service_role;`);
 for(const f of ['20261110070710_company_project_registry.sql','20261110073617_company_project_read_workspace.sql']) await db.exec(readFileSync(new URL('../../../supabase/migrations/'+f,import.meta.url),'utf8'));
 const list=(await db.query('SELECT id,code FROM company_projects')).rows;plaza=list.find(p=>p.code==='TOZON_PLAZA').id;tower=list.find(p=>p.code==='TOZON_TOWER').id;
 await db.query('INSERT INTO company_project_complexes VALUES(1,$1),(2,$2)',[plaza,tower]);
 await db.query('INSERT INTO company_project_leads VALUES(1,$1),(2,$2)',[plaza,tower]);
 await db.query('INSERT INTO company_project_cash_desks VALUES($1,$3),($2,$4)',[cashA,cashB,plaza,tower]);
 await db.query('INSERT INTO company_project_warehouses VALUES($1,$3),($2,$4)',[cashA,cashB,plaza,tower]);
 await db.query("INSERT INTO company_project_memberships(company_project_id,user_id,project_role) VALUES($1,10,'PARTNER'),($2,20,'MANAGER')",[plaza,tower]);
 await db.exec('INSERT INTO company_workspace_users VALUES(10,true),(20,true)');
 const sections=['inventory.view','leads.view','deals.view','finance.payments','finance.expenses','construction.stock'];
 await db.query('INSERT INTO company_workspace_access VALUES(10,$1,$3,true),(20,$2,$3,true)',[plaza,tower,sections]);
},30000);
afterAll(async()=>db.close());
describe.sequential('two project read-only isolation',()=>{
 it('lists only explicitly granted projects, without partner names or other registry data',async()=>{
   const a=(await read(10,null,'projects')).rows[0].result;const b=(await read(20,null,'projects')).rows[0].result;
   expect(a.projects.map(p=>p.id)).toEqual([plaza]);expect(b.projects.map(p=>p.id)).toEqual([tower]);expect(JSON.stringify(a)).not.toContain('Tozon Garden');
 });
 it.each(['complexes','units','leads','deals','payments','schedules','expenses','warehouses'])('restricts %s at the database boundary, even for an ADMIN pilot identity',async kind=>{
   await db.exec('SET ROLE service_role');try{
     const a=(await read(10,plaza,kind)).rows[0].result;
     const b=(await read(20,tower,kind)).rows[0].result;
     expect(a.records).toHaveLength(1);expect(b.records).toHaveLength(1);
     expect(a.records[0].id).toBe(kind==='warehouses'?cashA:1);expect(b.records[0].id).toBe(kind==='warehouses'?cashB:2);
     await expect(read(10,tower,kind)).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
     await expect(read(20,plaza,kind)).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
   }finally{await db.exec('RESET ROLE');}
 });
 it('hides cross-project record IDs behind 404 without leaking data and strips passport information',async()=>{
   await expect(read(10,plaza,'leads','2')).rejects.toThrow('WORKSPACE_RECORD_NOT_FOUND');
   await expect(read(10,plaza,'deals','2')).rejects.toThrow('WORKSPACE_RECORD_NOT_FOUND');
   const a=(await read(10,plaza,'leads')).rows[0].result;expect(a.records[0]).not.toHaveProperty('passport_number');
 });
 it('applies live revocation to an existing actor without relying on JWT claims',async()=>{
   await db.query('UPDATE company_workspace_access SET enabled=false WHERE user_id=20');
   await expect(read(20,tower,'units')).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
   expect((await read(20,null,'projects')).rows[0].result.projects).toHaveLength(0);
   await db.query('UPDATE company_workspace_access SET enabled=true WHERE user_id=20');
   await db.query('UPDATE users SET is_active=0 WHERE id=20');
   await expect(read(20,tower,'units')).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
   await db.query('UPDATE users SET is_active=1 WHERE id=20');
 });
 it('keeps per-section grants and membership restrictions separate from global CRM role',async()=>{
   await db.query("UPDATE company_workspace_access SET sections=ARRAY['inventory.view'] WHERE user_id=20");
   expect((await read(20,tower,'units')).rows[0].result.records).toHaveLength(1);
   await expect(read(20,tower,'payments')).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
   await expect(read(30,plaza,'units')).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
 });
 it('prevents escape by removing marker or creating a pilot roster entry without it',async()=>{
   await expect(db.query("UPDATE users SET permissions='[]' WHERE id=10")).rejects.toThrow('PROJECT_ONLY_MARKER_CANNOT_BE_REMOVED');
   await expect(db.query('INSERT INTO company_workspace_users VALUES(30,true)')).rejects.toThrow('PROJECT_ONLY_MARKER_REQUIRED');
 });
 it.each(['anon','authenticated'])('blocks RPC and private mapping access as %s',async role=>{
   await db.exec('SET ROLE '+role);try{
     await expect(read(10,plaza,'units')).rejects.toThrow('permission denied');
     for(const table of ['company_workspace_users','company_workspace_access','company_project_leads','company_project_cash_desks','company_project_warehouses'])await expect(db.query('SELECT * FROM '+table)).rejects.toThrow('permission denied');
   }finally{await db.exec('RESET ROLE');}
 });
 it('bounds pagination and refuses unsupported resources or null project context',async()=>{
   await expect(read(10,plaza,'units',null,'',10000)).rejects.toThrow('INVALID_WORKSPACE_PAGE');
   await expect(read(10,plaza,'files')).rejects.toThrow('WORKSPACE_RESOURCE_DISABLED');
   await expect(read(10,null,'units')).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
   const page=(await read(10,plaza,'units',null,'',1)).rows[0].result;expect(page.has_more).toBe(false);
 });
});
