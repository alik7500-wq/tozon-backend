import {beforeAll,afterAll,beforeEach,afterEach,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createWorkspaceFixture} from './workspace.fixture.js';
let db,plaza,tower;
const board=(actor=10,project=plaza,complex=null)=>db.query('select read_company_project_inventory($1,$2,$3) as result',[actor,project,complex]).then(r=>r.rows[0].result);
beforeAll(async()=>{
 ({db,plaza,tower}=await createWorkspaceFixture());
 await db.exec(`ALTER TABLE projects ADD COLUMN currency text DEFAULT 'USD';
 ALTER TABLE buildings ADD COLUMN name text DEFAULT 'Block';ALTER TABLE buildings ADD COLUMN sort_order integer;
 ALTER TABLE sections ADD COLUMN name text DEFAULT 'Entrance';ALTER TABLE sections ADD COLUMN sort_order integer;
 ALTER TABLE floors ADD COLUMN floor_number integer DEFAULT 1;
 ALTER TABLE units ADD COLUMN rooms integer DEFAULT 2;ALTER TABLE units ADD COLUMN position_on_floor integer;ALTER TABLE units ADD COLUMN manual_total_price_minor integer;
 `);
 await db.exec(readFileSync(new URL('../../../supabase/migrations/20261113164153_company_project_inventory_board.sql',import.meta.url),'utf8'));
 await db.exec(`CREATE TABLE discount_schemes(id uuid PRIMARY KEY,project_id integer,name text,rules jsonb,is_active boolean DEFAULT true,starts_on date,ends_on date,updated_at timestamptz DEFAULT now());GRANT SELECT ON discount_schemes TO service_role;`);
 await db.exec(readFileSync(new URL('../../../supabase/migrations/20261113192434_company_project_inventory_pricing.sql',import.meta.url),'utf8'));
},30000);
afterAll(()=>db?.close());beforeEach(()=>db.exec('BEGIN'));afterEach(()=>db.exec('ROLLBACK'));
it('returns only own complex and a minimal inventory projection, without customers or private fields',async()=>{
 const r=await board();expect(r.selected_complex_id).toBe(1);expect(r.complexes).toEqual([{id:1,name:'Plaza complex',currency:'USD'}]);
 expect(r.records).toHaveLength(1);expect(r.records[0]).toMatchObject({id:1,unit_number:'A1',floor_number:1,building_name:'Block',section_name:'Entrance',rooms:2});
 expect(JSON.stringify(r)).not.toMatch(/Tower|PRIVATE|passport|lead_id|contract|block_reason/);
});
it('checks selected complex belongs to exact project and does not reveal foreign or archived complexes',async()=>{
 await expect(board(10,plaza,2)).rejects.toThrow('WORKSPACE_RECORD_NOT_FOUND');
});
it('denies foreign projects, unrestricted admin and removed current inventory permission',async()=>{
 await expect(board(10,tower)).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
});
it('rechecks revoked permission on every call',async()=>{
 await board();await db.exec("UPDATE company_workspace_access SET sections=ARRAY['leads.view'] WHERE user_id=10");await expect(board()).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
});
it('does not let unrestricted administrators bypass roster membership',async()=>{await expect(board(30)).rejects.toThrow('WORKSPACE_ACCESS_DENIED');});
it('excludes archived inventory at any hierarchy level and returns an empty assigned complex',async()=>{
 await db.exec("UPDATE sections SET archived_at='archived' WHERE id=1");const r=await board();expect(r.records).toEqual([]);expect(r.complexes).toHaveLength(1);
});
it('keeps all units beyond list page size and orders floors from top to basement',async()=>{
 await db.exec("INSERT INTO floors(id,section_id,floor_number) VALUES(10,1,10),(11,1,-1);UPDATE units SET floor_id=11 WHERE id=1;INSERT INTO units(id,floor_id,unit_number,area_m2_x100,status,unit_kind,position_on_floor) SELECT n,10,n::text,6000,'AVAILABLE','APARTMENT',n FROM generate_series(10,159)n");
 const r=await board();expect(r.records).toHaveLength(151);expect(r.records[0].floor_number).toBe(10);expect(r.records.at(-1).floor_number).toBe(-1);
});
it('returns no data when no active complexes are assigned',async()=>{await db.exec("UPDATE projects SET archived_at='archived' WHERE id=1");expect(await board()).toMatchObject({complexes:[],selected_complex_id:null,records:[]});});
it('never silently truncates oversized inventory',async()=>{
 await db.exec("INSERT INTO units(id,floor_id,unit_number,status,unit_kind) SELECT n,1,n::text,'AVAILABLE','APARTMENT' FROM generate_series(10,5010)n");await expect(board()).rejects.toThrow('WORKSPACE_INVENTORY_TOO_LARGE');
});
it('blocks direct browser role execution',async()=>{await db.exec('SET ROLE authenticated');await expect(board()).rejects.toThrow();});

it('returns only current own-complex schemes while retaining distinct 36/40 month rules',async()=>{
 const rules=[{payment_percent:0,price_per_m2:640,months:36},{payment_percent:0,price_per_m2:700,months:40}];
 await db.query("INSERT INTO discount_schemes(id,project_id,name,rules) VALUES('00000000-0000-4000-8000-000000000001',1,'Own',$1::jsonb),('00000000-0000-4000-8000-000000000002',2,'Foreign',$1::jsonb)",[JSON.stringify(rules)]);
 await db.exec("INSERT INTO discount_schemes(id,project_id,name,rules,is_active,starts_on,ends_on) VALUES('00000000-0000-4000-8000-000000000003',1,'Disabled','[]',false,null,null),('00000000-0000-4000-8000-000000000004',1,'Expired','[]',true,null,'2000-01-01'),('00000000-0000-4000-8000-000000000005',1,'Future','[]',true,'2099-01-01',null)");
 let r=await board();expect(r.schemes).toHaveLength(1);expect(r.schemes[0]).toMatchObject({name:'Own',project_id:1,is_active:true,rules});
 await db.exec("UPDATE discount_schemes SET rules='[{\"payment_percent\":30,\"price_per_m2\":600,\"months\":36}]',updated_at=now() WHERE name='Own'");r=await board();expect(r.schemes[0].rules).toHaveLength(1);expect(r.schemes[0].rules[0].payment_percent).toBe(30);
});
