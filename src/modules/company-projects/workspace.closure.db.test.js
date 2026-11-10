import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createClosureFixture} from './workspace.closure-fixture.js';
let db,plaza,tower,unit=2000;
const cmd=(kind,payload,id=randomUUID(),actor=10,project=plaza)=>db.query('SELECT execute_company_project_command($1,$2,$3,$4,$5::jsonb) result',[actor,project,id,kind,JSON.stringify(payload)]).then(r=>r.rows[0].result);
async function draft(){const id=unit++;await db.query("INSERT INTO units(id,floor_id,unit_number,area_m2_x100,price_per_m2_minor,status,unit_kind) VALUES($1,1,$2,6000,70000,'AVAILABLE','APARTMENT')",[id,String(id)]);const r=await cmd('DEAL_DRAFT',{unit_id:id,lead_id:1,final_price_minor:4200000,date:'2026-11-10'});return (await db.query('SELECT * FROM deals WHERE id=$1',[r.id])).rows[0];}
async function signed(){const d=await draft();await cmd('SIGN_DEAL',{deal_id:d.id,expected_updated_at:d.updated_at,down_payment_minor:0,installment_months:36});return (await db.query('SELECT * FROM deals WHERE id=$1',[d.id])).rows[0];}
const body=d=>({deal_id:d.id,expected_updated_at:d.updated_at,reason:'Клиент отказался'});
const terminate=d=>({...body(d),basis:'Соглашение № 1',basis_date:'2026-11-10'});
beforeAll(async()=>{({db,plaza,tower}=await createClosureFixture());await db.exec("UPDATE company_workspace_access SET write_sections=write_sections||ARRAY['contracts.sign','contracts.cancel','contracts.terminate'] WHERE user_id=10");await db.query("UPDATE company_projects SET director_name='Director',director_authority='Authority' WHERE id=$1",[plaza]);},30000);
afterAll(()=>db?.close());
describe.sequential('unpaid project contract closure',()=>{
 it('cancels its own draft atomically, releases the unit and retains the audit and client',async()=>{
  const d=await draft(),id=randomUUID(),p=body(d);const r=await cmd('CANCEL_DRAFT',p,id);expect(r.status).toBe('CANCELLED');expect((await cmd('CANCEL_DRAFT',p,id)).idempotent).toBe(true);
  const saved=(await db.query('SELECT * FROM deals WHERE id=$1',[d.id])).rows[0];expect(saved.company_closure_snapshot).toMatchObject({actor_id:10,kind:'CANCEL_DRAFT',reason:p.reason,previous_status:'DRAFT'});expect((await db.query('SELECT status FROM units WHERE id=$1',[d.unit_id])).rows[0].status).toBe('AVAILABLE');expect((await db.query('SELECT count(*)::int n FROM leads WHERE id=1')).rows[0].n).toBe(1);
  await expect(cmd('CANCEL_DRAFT',{...p,reason:'Другая причина'},id)).rejects.toThrow('WORKSPACE_REQUEST_REUSED');
 });
 it('requires a signed contract and a distinct termination right and basis',async()=>{
  const d=await signed();await expect(cmd('CANCEL_DRAFT',body(d))).rejects.toThrow('STALE_CLOSURE_TARGET');
  await db.exec("UPDATE company_workspace_access SET write_sections=array_remove(write_sections,'contracts.terminate') WHERE user_id=10");await expect(cmd('TERMINATE_UNPAID',terminate(d))).rejects.toThrow('WORKSPACE_CLOSURE_DENIED');await db.exec("UPDATE company_workspace_access SET write_sections=array_append(write_sections,'contracts.terminate') WHERE user_id=10");
  for(const change of [{basis:''},{basis_date:'2026-11-09'},{basis_date:'2999-01-01'},{expected_updated_at:'stale'}])await expect(cmd('TERMINATE_UNPAID',{...terminate(d),...change})).rejects.toThrow();
  await cmd('TERMINATE_UNPAID',terminate(d));const graph=(await db.query('SELECT * FROM deal_payment_schedules WHERE deal_id=$1',[d.id])).rows;expect(graph).toHaveLength(36);expect(graph.every(x=>x.status==='CANCELLED')).toBe(true);expect(graph.reduce((n,x)=>n+x.amount_minor,0)).toBe(4200000);
  const saved=(await db.query('SELECT * FROM deals WHERE id=$1',[d.id])).rows[0];expect(saved.company_director_snapshot.director_name).toBe('Director');expect(saved.company_closure_snapshot.basis).toBe('Соглашение № 1');
 });
 it('refuses active and voided financial history and never removes it',async()=>{
  for(const status of ['ACTIVE','VOIDED']){const d=await signed();await db.query("INSERT INTO payments(deal_id,cash_desk_id,amount_minor,currency,payment_date,status) VALUES($1,'00000000-0000-4000-8000-000000000001',100,'USD','2026-11-10',$2)",[d.id,status]);await expect(cmd('TERMINATE_UNPAID',terminate(d))).rejects.toThrow('CLOSURE_FINANCIAL_REVIEW_REQUIRED');expect((await db.query('SELECT status FROM deals WHERE id=$1',[d.id])).rows[0].status).toBe('SIGNED');await expect(db.query('DELETE FROM payments WHERE deal_id=$1',[d.id])).rejects.toThrow('SCOPED_FINANCIAL_HISTORY_IMMUTABLE');}
 });
 it('rejects foreign IDs, wrong project, stale unit state and changed hierarchy without writes',async()=>{
  const d=await draft();await expect(cmd('CANCEL_DRAFT',body(d),randomUUID(),20,tower)).rejects.toThrow();await expect(cmd('CANCEL_DRAFT',body(d),randomUUID(),10,tower)).rejects.toThrow();await db.query("UPDATE units SET status='SOLD' WHERE id=$1",[d.unit_id]);await expect(cmd('CANCEL_DRAFT',body(d))).rejects.toThrow('CLOSURE_UNIT_REQUIRES_REVIEW');await db.query("UPDATE units SET status='RESERVED' WHERE id=$1",[d.unit_id]);
  await db.query('UPDATE company_project_complexes SET company_project_id=$1 WHERE complex_id=1',[tower]);await expect(cmd('CANCEL_DRAFT',body(d))).rejects.toThrow();await db.query('UPDATE company_project_complexes SET company_project_id=$1 WHERE complex_id=1',[plaza]);expect((await db.query('SELECT status FROM deals WHERE id=$1',[d.id])).rows[0].status).toBe('DRAFT');
 });
 it('rolls back the closure and graph when the final unit update fails',async()=>{
  const d=await signed();await db.exec("CREATE FUNCTION fail_closure_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='AVAILABLE' THEN RAISE EXCEPTION 'INJECTED_RELEASE_FAILURE';END IF;RETURN NEW;END $$;CREATE TRIGGER fail_closure_test BEFORE UPDATE ON units FOR EACH ROW EXECUTE FUNCTION fail_closure_test()");await expect(cmd('TERMINATE_UNPAID',terminate(d))).rejects.toThrow('INJECTED_RELEASE_FAILURE');await db.exec('DROP TRIGGER fail_closure_test ON units;DROP FUNCTION fail_closure_test()');expect((await db.query('SELECT status FROM deals WHERE id=$1',[d.id])).rows[0].status).toBe('SIGNED');expect((await db.query("SELECT count(*)::int n FROM deal_payment_schedules WHERE deal_id=$1 AND status='CANCELLED'",[d.id])).rows[0].n).toBe(0);expect((await db.query("SELECT count(*)::int n FROM company_project_commands WHERE kind='TERMINATE_UNPAID' AND payload->>'deal_id'=$1",[String(d.id)])).rows[0].n).toBe(0);
 });
 it('blocks reopening, deleting or posting payments/graph rows after closure',async()=>{
  const d=await signed();await expect(db.query("UPDATE deals SET status='CANCELLED' WHERE id=$1",[d.id])).rejects.toThrow('PROJECT_CLOSURE_COMMAND_REQUIRED');await cmd('TERMINATE_UNPAID',terminate(d));
  for(const sql of ["UPDATE deals SET status='SIGNED' WHERE id=$1",'DELETE FROM deals WHERE id=$1'])await expect(db.query(sql,[d.id])).rejects.toThrow();
  await expect(db.query("UPDATE deal_payment_schedules SET status='UPCOMING' WHERE deal_id=$1",[d.id])).rejects.toThrow('CLOSED_PROJECT_SCHEDULE_IMMUTABLE');await expect(db.query('DELETE FROM deal_payment_schedules WHERE deal_id=$1',[d.id])).rejects.toThrow();
  await expect(db.query("INSERT INTO payments(deal_id,cash_desk_id,amount_minor,currency,status) VALUES($1,'00000000-0000-4000-8000-000000000001',100,'USD','ACTIVE')",[d.id])).rejects.toThrow('PROJECT_DEAL_NOT_SIGNED');
 });
 it('keeps normal atomic payments working and routes paid termination to settlement review',async()=>{
  const d=await signed();const r=await cmd('PAYMENT',{deal_id:d.id,cash_desk_id:'00000000-0000-4000-8000-000000000001',amount_minor:92400,currency:'TJS',exchange_rate:9.24,date:'2026-11-10'});expect(r.resource).toBe('payments');
  await expect(cmd('TERMINATE_UNPAID',terminate(d))).rejects.toThrow('CLOSURE_FINANCIAL_REVIEW_REQUIRED');expect((await db.query('SELECT sum(paid_amount_minor)::int paid FROM deal_payment_schedules WHERE deal_id=$1',[d.id])).rows[0].paid).toBe(10000);
 });
 it('preserves old closed contracts when the same unit is sold again',async()=>{
  const d=await draft(),request=randomUUID();await cmd('CANCEL_DRAFT',body(d),request);const newer=await cmd('DEAL_DRAFT',{unit_id:d.unit_id,lead_id:1,final_price_minor:4200000,date:'2026-11-10'});expect(newer.status).toBe('DRAFT');expect((await db.query('SELECT status FROM deals WHERE id=$1',[d.id])).rows[0].status).toBe('CANCELLED');expect(newer.id).not.toBe(d.id);expect((await cmd('CANCEL_DRAFT',body(d),request)).idempotent).toBe(true);expect((await db.query('SELECT status FROM units WHERE id=$1',[d.unit_id])).rows[0].status).toBe('RESERVED');
 });
 it('checks current permissions again for idempotent replay and returns only own eligible targets',async()=>{
  const d=await draft(),id=randomUUID(),p=body(d);await cmd('CANCEL_DRAFT',p,id);await db.exec("UPDATE company_workspace_access SET write_sections=array_remove(write_sections,'contracts.cancel') WHERE user_id=10");await expect(cmd('CANCEL_DRAFT',p,id)).rejects.toThrow('WORKSPACE_CLOSURE_DENIED');await db.exec("UPDATE company_workspace_access SET write_sections=array_append(write_sections,'contracts.cancel') WHERE user_id=10");
  const context=(await db.query("SELECT company_project_operation_options(10,$1) r",[plaza])).rows[0].r;expect(context.commands).toContain('CANCEL_DRAFT');expect(context.commands).toContain('TERMINATE_UNPAID');
  const targets=(await db.query("SELECT company_project_operation_options(10,$1,'cancel_drafts') r",[plaza])).rows[0].r;expect(targets.records.every(x=>x.status==='DRAFT')).toBe(true);expect(targets.records.some(x=>x.id===2)).toBe(false);
  await db.exec("UPDATE company_workspace_access SET sections=ARRAY['inventory.view'] WHERE user_id=20");expect((await db.query('SELECT company_project_operation_options(20,$1) r',[tower])).rows[0].r.commands).toEqual([]);
 });
});
