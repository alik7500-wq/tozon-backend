import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createClosureFixture} from './workspace.closure-fixture.js';
let db,plaza,tower,today;
const call=(name,args)=>db.query(`SELECT ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args).then(r=>r.rows[0].r);
const config=(actor=30,project=plaza)=>call('company_project_reminder_configuration',[actor,project]);
const save=(revision,enabled=true,actor=30,project=plaza)=>call('save_company_project_reminders',[actor,project,revision,enabled,3,today]);
const read=(actor=10,project=plaza)=>call('read_company_project_reminders',[actor,project]);
beforeAll(async()=>{
 ({db,plaza,tower}=await createClosureFixture());
 await db.exec(readFileSync(new URL('../../../supabase/migrations/20261110204856_company_project_internal_reminders.sql',import.meta.url),'utf8'));
 today=(await db.query("SELECT (now() AT TIME ZONE 'Asia/Dushanbe')::date::text d")).rows[0].d;
 await db.query('UPDATE deals SET company_project_id=$1 WHERE id=1',[plaza]);await db.query('UPDATE deals SET company_project_id=$1 WHERE id=2',[tower]);
 await db.query('UPDATE deal_payment_schedules SET due_date=$1,amount_minor=10000,paid_amount_minor=0',[today]);
},30000);
afterAll(()=>db?.close());
describe.sequential('project internal reminders',()=>{
 it('defaults off and requires a company admin instead of an ADMIN-labelled scoped identity',async()=>{
  expect(await config()).toMatchObject({enabled:false,revision:0});expect((await read()).records).toEqual([]);await expect(config(10)).rejects.toThrow('REMINDER_ADMIN_REQUIRED');
  await db.exec("UPDATE users SET permissions='[\"access.v2\",\"settings.view\"]' WHERE id=30");await expect(config()).rejects.toThrow();await db.exec("UPDATE users SET permissions='[]' WHERE id=30");
 });
 it('saves revisions/history atomically and rejects concurrent stale edits or missing backlog cutoff',async()=>{
  await expect(call('save_company_project_reminders',[30,plaza,0,true,3,null])).rejects.toThrow('INVALID_REMINDER_SETTINGS');expect((await save(0)).revision).toBe(1);await expect(save(0)).rejects.toThrow('STALE_REMINDER_SETTINGS');expect((await db.query('SELECT count(*)::int n FROM company_project_reminder_history')).rows[0].n).toBe(1);
 });
 it('generates once for only current members of the own project and repeats without duplicates',async()=>{
  const r=await read();expect(r.records).toHaveLength(1);expect(r.records[0].client_name).toBe('Plaza Client');expect(r.records[0].reminder_kind).toBe('DUE');expect((await read()).records[0].id).toBe(r.records[0].id);
  expect((await read(20,tower)).records).toEqual([]);await expect(read(20,plaza)).rejects.toThrow();
 });
 it('marks only the actors own current reminder and requires current finance and deal rights',async()=>{
  const id=(await read()).records[0].id;await expect(call('ack_company_project_reminder',[20,tower,id])).rejects.toThrow('REMINDER_NOT_FOUND');expect(await call('ack_company_project_reminder',[10,plaza,id])).toMatchObject({is_read:true});
  await db.exec("UPDATE company_workspace_access SET sections=array_remove(sections,'finance.payments') WHERE user_id=10");await expect(read()).rejects.toThrow('REMINDER_ACCESS_DENIED');await db.exec("UPDATE company_workspace_access SET sections=array_append(sections,'finance.payments') WHERE user_id=10");
 });
 it('hides stored reminders immediately when paid, cancelled or disabled without deleting history',async()=>{
  await db.exec("UPDATE deal_payment_schedules SET status='PAID',paid_amount_minor=10000 WHERE id=1");expect((await read()).records).toEqual([]);await db.exec("UPDATE deal_payment_schedules SET status='UPCOMING',paid_amount_minor=0 WHERE id=1");
  await db.exec("UPDATE deal_payment_schedules SET status='CANCELLED' WHERE id=1");expect((await read()).records).toEqual([]);await db.exec("UPDATE deal_payment_schedules SET status='UPCOMING' WHERE id=1");
  await save(1,false);expect((await read()).records).toEqual([]);expect((await db.query('SELECT count(*)::int n FROM company_project_reminders')).rows[0].n).toBe(1);await save(2,true);
 });
 it('does not expose stored notifications after mapping or user access changes',async()=>{
  await db.query('UPDATE company_project_complexes SET company_project_id=$1 WHERE complex_id=1',[tower]);expect((await read()).records).toEqual([]);await db.query('UPDATE company_project_complexes SET company_project_id=$1 WHERE complex_id=1',[plaza]);
  await db.exec('UPDATE company_workspace_access SET enabled=false WHERE user_id=10');await expect(read()).rejects.toThrow();await db.exec('UPDATE company_workspace_access SET enabled=true WHERE user_id=10');
 });
 it('restricts tables and functions from browser roles',async()=>{
  await db.exec('SET ROLE authenticated');await expect(read()).rejects.toThrow();await expect(db.query('SELECT * FROM company_project_reminders')).rejects.toThrow();await db.exec('RESET ROLE');
 });
});
