import {beforeAll,afterAll,beforeEach,afterEach,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createWorkspaceFixture} from './workspace.fixture.js';
let db,plaza,tower;
const search=(q,actor=10,project=plaza,resource=null,record=null)=>db.query('select search_company_project_workspace($1,$2,$3,$4,$5) result',[actor,project,q,resource,record]).then(r=>r.rows[0].result);
const group=(r,kind)=>r.groups.find(g=>g.resource===kind);
async function denied(call,message){await db.exec('SAVEPOINT denial');try{await expect(call()).rejects.toThrow(message);}finally{await db.exec('ROLLBACK TO denial;RELEASE denial');}}
beforeAll(async()=>{
 ({db,plaza,tower}=await createWorkspaceFixture());await db.exec('ALTER TABLE deals ADD COLUMN company_project_id uuid');
 await db.exec(readFileSync(new URL('../../../supabase/migrations/20261116181948_company_project_search.sql',import.meta.url),'utf8'));
},30000);
afterAll(()=>db?.close());beforeEach(()=>db.exec('BEGIN'));afterEach(()=>db.exec('ROLLBACK'));
it('searches the whole project with explicit minimal projections and no foreign matches',async()=>{
 const r=await search('plaza');expect(group(r,'leads').records).toEqual([{id:1,title:'Plaza Client',subtitle:'111',status:'WON'}]);expect(group(r,'units').records[0]).toMatchObject({id:1,title:'A1',subtitle:'Plaza complex'});
 expect(JSON.stringify(r)).not.toMatch(/Tower|PRIVATE|passport|amount|partner|lead_id/);
 expect((await search('Tower')).groups.every(g=>g.records.length===0)).toBe(true);
 expect(group(await search('1'),'units').records[0].id).toBe(1);const contracts=await search('contract');expect(group(contracts,'deals').records.map(r=>r.id)).toEqual([1]);
});
it('treats wildcard characters literally and searches formatted phone digits',async()=>{
 expect((await search('%%')).groups.every(g=>g.records.length===0)).toBe(true);
 await db.exec("UPDATE leads SET phone='+992 (92) 123-45-67',full_name='АКМАЛХОН' WHERE id=1");expect(group(await search('9212345'),'leads').records[0].id).toBe(1);expect(group(await search('акмал'),'leads').records[0].id).toBe(1);
 expect(group(await search("' OR 1=1 --"),'leads').records).toEqual([]);
});
it('does not match or expose fields from ungranted sections',async()=>{
 await db.exec("UPDATE company_workspace_access SET sections=ARRAY['deals.view'] WHERE user_id=10");const r=await search('Plaza');expect(r.groups.map(g=>g.resource)).toEqual(['deals']);expect(r.groups[0].records).toEqual([]);
 await denied(()=>search(null,10,plaza,'leads',1),'WORKSPACE_ACCESS_DENIED');expect((await search('CONTRACT')).groups[0].records[0].title).toBe('A-CONTRACT');
});
it('rechecks membership, roster, active user and grants on every search and record preview',async()=>{
 await denied(()=>search('Plaza',10,tower),'WORKSPACE_ACCESS_DENIED');await denied(()=>search('Plaza',30),'WORKSPACE_ACCESS_DENIED');
 for(const statement of ["UPDATE company_workspace_access SET enabled=false WHERE user_id=10","UPDATE company_workspace_users SET enabled=false WHERE user_id=10","UPDATE users SET is_active=0 WHERE id=10","UPDATE company_workspace_access SET sections=ARRAY['finance.payments'] WHERE user_id=10"]){
  await db.exec('SAVEPOINT revoke');await db.exec(statement);await denied(()=>search('Plaza'),'WORKSPACE_ACCESS_DENIED');await denied(()=>search(null,10,plaza,'leads',1),'WORKSPACE_ACCESS_DENIED');await db.exec('ROLLBACK TO revoke;RELEASE revoke');
 }
});
it('rechecks selected records and hides foreign IDs and moved or archived records behind 404',async()=>{
 expect(await search(null,10,plaza,'leads',1)).toMatchObject({resource:'leads',record:{id:1,title:'Plaza Client'}});
 for(const kind of ['leads','deals','units'])await denied(()=>search(null,10,plaza,kind,2),'WORKSPACE_RECORD_NOT_FOUND');
 await db.exec("UPDATE leads SET archived_at='archived' WHERE id=1");await denied(()=>search(null,10,plaza,'leads',1),'WORKSPACE_RECORD_NOT_FOUND');
 await db.query('UPDATE company_project_leads SET company_project_id=$1 WHERE lead_id=1',[tower]);await denied(()=>search(null,10,plaza,'deals',1),'WORKSPACE_RECORD_NOT_FOUND');
});
it('excludes archived unit hierarchy and contradictory explicit deal projects',async()=>{
 await db.query('UPDATE deals SET company_project_id=$1 WHERE id=1',[tower]);expect(group(await search('CONTRACT'),'deals').records).toEqual([]);await denied(()=>search(null,10,plaza,'deals',1),'WORKSPACE_RECORD_NOT_FOUND');
 await db.exec("UPDATE floors SET archived_at='archived' WHERE id=1");expect(group(await search('Plaza'),'units').records).toEqual([]);
});
it('finds records beyond a list page and reports the per-section cap without exposing totals',async()=>{
 await db.exec("INSERT INTO leads(id,full_name,phone,status) SELECT n,'Own Match '||n,'111','NEW' FROM generate_series(10,80)n");await db.query("INSERT INTO company_project_leads SELECT n,$1 FROM generate_series(10,80)n",[plaza]);
 const r=group(await search('Own Match'),'leads');expect(r.records).toHaveLength(10);expect(r.has_more).toBe(true);expect(r).not.toHaveProperty('total');
 expect(group(await search('Own Match 80'),'leads').records[0].id).toBe(80);expect((await search(null,10,plaza,'leads',80)).record.id).toBe(80);
});
it('rejects malformed or contradictory search and detail arguments',async()=>{
 for(const q of ['',null,'a','x'.repeat(101),'ab\ncd'])await denied(()=>search(q),'WORKSPACE_INVALID_SEARCH');
 for(const [q,kind,id] of [['abc','leads',1],[null,'expenses',1],[null,'units',null],[null,null,1],[null,'units',0]])await denied(()=>search(q,10,plaza,kind,id),'WORKSPACE_INVALID_SEARCH');
});
it('has no browser-role execution or business writes',async()=>{
 const before=await db.query('select * from leads order by id');await db.exec('SET ROLE service_role');await search('Plaza');await search(null,10,plaza,'leads',1);await db.exec('RESET ROLE');expect(await db.query('select * from leads order by id')).toEqual(before);
 await db.exec('SET ROLE authenticated');await expect(search('Plaza')).rejects.toThrow();
});
