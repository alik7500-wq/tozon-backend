import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { createWorkspaceFixture } from './workspace.fixture.js';
let db, plaza, tower;
const cashA='00000000-0000-4000-8000-000000000001',cashB='00000000-0000-4000-8000-000000000002';
const read = (actor,project,resource,record=null,after='',limit=50) => db.query('SELECT public.read_company_project_workspace($1,$2,$3,$4,$5,$6) AS result',[actor,project,resource,record,after,limit]);
beforeAll(async()=>{({db,plaza,tower}=await createWorkspaceFixture());},30000);
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
