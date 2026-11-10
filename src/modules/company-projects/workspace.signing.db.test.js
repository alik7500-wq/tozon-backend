import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createWriteFixture} from './workspace.write-fixture.js';
let db,plaza,tower,unitNumber=1000;
const scheme='20000000-0000-4000-8000-000000000001';
const rules=[{payment_percent:0,price_per_m2:640,discount_percent:8.57,months:36},{payment_percent:0,price_per_m2:700,discount_percent:0,months:40},{payment_percent:100,price_per_m2:550,discount_percent:21.43,months:0}];
const key=r=>JSON.stringify([r.payment_percent,r.price_per_m2,r.discount_percent,r.months]);
const cmd=(kind,payload,request=randomUUID(),actor=10,project=plaza)=>db.query('SELECT execute_company_project_command($1,$2,$3,$4,$5::jsonb) AS result',[actor,project,request,kind,JSON.stringify(payload)]);
const options=(kind,actor=10,project=plaza,after='',limit=100)=>db.query('SELECT company_project_operation_options($1,$2,$3,$4,$5) AS result',[actor,project,kind,after,limit]);
async function draft(){
 const id=unitNumber++;
 await db.query("INSERT INTO units(id,floor_id,unit_number,area_m2_x100,price_per_m2_minor,status,unit_kind) VALUES($1,1,$2,6000,70000,'AVAILABLE','APARTMENT')",[id,String(id)]);
 const r=(await cmd('DEAL_DRAFT',{unit_id:id,lead_id:1,final_price_minor:4200000,date:'2026-11-10'})).rows[0].result;
 return (await db.query('SELECT * FROM deals WHERE id=$1',[r.id])).rows[0];
}
async function payload(d,index=0,extra={}){
 const s=(await db.query('SELECT updated_at FROM discount_schemes WHERE id=$1',[scheme])).rows[0];
 return {deal_id:d.id,expected_updated_at:d.updated_at,scheme_id:scheme,scheme_updated_at:s.updated_at,rule_key:key(rules[index]),down_payment_minor:index===2?3300000:0,installment_months:rules[index].months,...extra};
}
beforeAll(async()=>{
 ({db,plaza,tower}=await createWriteFixture());
 await db.exec("UPDATE company_workspace_access SET write_sections=array_append(write_sections,'contracts.sign') WHERE user_id=10");
 await db.query("UPDATE company_projects SET director_name='Director A',director_authority='Authority A' WHERE id=$1",[plaza]);
 await db.query("INSERT INTO discount_schemes(id,project_id,name,rules) VALUES($1,1,'Two zero-deposit offers',$2::jsonb)",[scheme,JSON.stringify(rules)]);
},30000);
afterAll(async()=>db?.close());
describe.sequential('project signing and scoped form options',()=>{
 it('selects the exact 36-month offer, creates a balanced schedule and signs all records atomically',async()=>{
  const d=await draft(),body=await payload(d),request=randomUUID();
  const result=(await cmd('SIGN_DEAL',body,request)).rows[0].result;
  expect(result.status).toBe('SIGNED');expect(result.final_price_minor).toBe(3840000);
  const schedules=(await db.query('SELECT * FROM deal_payment_schedules WHERE deal_id=$1 ORDER BY payment_number',[d.id])).rows;
  expect(schedules).toHaveLength(36);expect(schedules.reduce((n,s)=>n+s.amount_minor,0)).toBe(3840000);expect(schedules[0].due_date).toBe('2026-11-10');
  expect(Math.max(...schedules.map(s=>s.amount_minor))-Math.min(...schedules.map(s=>s.amount_minor))).toBe(1);
  expect((await db.query('SELECT status FROM units WHERE id=$1',[d.unit_id])).rows[0].status).toBe('SOLD');
  expect((await cmd('SIGN_DEAL',body,request)).rows[0].result.idempotent).toBe(true);
  expect((await db.query('SELECT count(*)::int AS n FROM deal_payment_schedules WHERE deal_id=$1',[d.id])).rows[0].n).toBe(36);
 });
 it('keeps a different 40-month zero-deposit offer separate',async()=>{
  const d=await draft();const result=(await cmd('SIGN_DEAL',await payload(d,1))).rows[0].result;
  expect(result.final_price_minor).toBe(4200000);expect(result.installment_months).toBe(40);
 });
 it('signs full payment without monthly rows and freezes the actual signing director',async()=>{
  const d=await draft();await db.query("UPDATE company_projects SET director_name='Signing director' WHERE id=$1",[plaza]);
  await cmd('SIGN_DEAL',await payload(d,2));
  const saved=(await db.query('SELECT company_director_snapshot,status FROM deals WHERE id=$1',[d.id])).rows[0];expect(saved.company_director_snapshot.director_name).toBe('Signing director');
  await db.query("UPDATE company_projects SET director_name='Future director' WHERE id=$1",[plaza]);
  expect((await db.query('SELECT company_director_snapshot FROM deals WHERE id=$1',[d.id])).rows[0].company_director_snapshot.director_name).toBe('Signing director');
  expect((await db.query('SELECT * FROM deal_payment_schedules WHERE deal_id=$1',[d.id])).rows).toHaveLength(0);
 });
 it('rejects outdated draft/scheme, ambiguous or foreign offer and retroactive first payment without writes',async()=>{
  const d=await draft(),body=await payload(d);
  for(const bad of [{...body,expected_updated_at:'stale'},{...body,scheme_updated_at:'2000-01-01'},{...body,rule_key:'[0,null,0,36]'},{...body,first_payment_date:'2026-01-01'},{...body,installment_months:40}])await expect(cmd('SIGN_DEAL',bad)).rejects.toThrow();
  expect((await db.query('SELECT status FROM deals WHERE id=$1',[d.id])).rows[0].status).toBe('DRAFT');
  expect((await db.query('SELECT * FROM deal_payment_schedules WHERE deal_id=$1',[d.id])).rows).toHaveLength(0);
 });
 it('requires signing rights separately from drafting and enforces the global discount limit',async()=>{
  const d=await draft(),body=await payload(d,2);
  await db.exec("UPDATE company_workspace_access SET write_sections=array_remove(write_sections,'contracts.sign') WHERE user_id=10");
  await expect(cmd('SIGN_DEAL',body)).rejects.toThrow('WORKSPACE_SIGN_DENIED');
  await db.exec("UPDATE company_workspace_access SET write_sections=array_append(write_sections,'contracts.sign') WHERE user_id=10");
  await db.exec("UPDATE crm_document_settings SET data='{\"max_discount_percent\":10}'");
  await expect(cmd('SIGN_DEAL',body)).rejects.toThrow('INVALID_SIGN_PRICE');
  await db.exec("UPDATE crm_document_settings SET data='{\"max_discount_percent\":100}'");
 });
 it('rolls back schedules, contract and audit if the final unit update fails',async()=>{
  const d=await draft();
  await db.exec("CREATE FUNCTION public.fail_sign_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='SOLD' THEN RAISE EXCEPTION 'INJECTED_FINAL_FAILURE';END IF;RETURN NEW;END $$;CREATE TRIGGER fail_sign_test BEFORE UPDATE ON units FOR EACH ROW EXECUTE FUNCTION fail_sign_test()");
  await expect(cmd('SIGN_DEAL',await payload(d))).rejects.toThrow('INJECTED_FINAL_FAILURE');
  await db.exec('DROP TRIGGER fail_sign_test ON units;DROP FUNCTION fail_sign_test()');
  expect((await db.query('SELECT status FROM deals WHERE id=$1',[d.id])).rows[0].status).toBe('DRAFT');
  expect((await db.query('SELECT * FROM deal_payment_schedules WHERE deal_id=$1',[d.id])).rows).toHaveLength(0);
 });
 it('blocks a foreign actor, changed unit ownership, archived buyer and a missing director',async()=>{
  const d=await draft(),body=await payload(d);
  await expect(cmd('SIGN_DEAL',body,randomUUID(),20,tower)).rejects.toThrow();
  await db.query("UPDATE company_projects SET director_name='' WHERE id=$1",[plaza]);
  await expect(cmd('SIGN_DEAL',body)).rejects.toThrow('PROJECT_SIGNER_NOT_CONFIGURED');
  await db.query("UPDATE company_projects SET director_name='Director A' WHERE id=$1",[plaza]);
  await db.exec("UPDATE leads SET archived_at='2026-11-10' WHERE id=1");
  await expect(cmd('SIGN_DEAL',body)).rejects.toThrow('BUYER_UNAVAILABLE');
  await db.exec('UPDATE leads SET archived_at=NULL WHERE id=1');
  await db.query('UPDATE company_project_complexes SET company_project_id=$1 WHERE complex_id=1',[tower]);
  await expect(cmd('SIGN_DEAL',body)).rejects.toThrow();
  await db.query('UPDATE company_project_complexes SET company_project_id=$1 WHERE complex_id=1',[plaza]);
 });
 it('returns own selector records with bounded pagination and no foreign identifiers',async()=>{
  const context=(await options('context')).rows[0].result;expect(context.commands).toContain('SIGN_DEAL');
  const dealOptions=(await options('deals')).rows[0].result.records;expect(dealOptions.some(d=>d.id===2)).toBe(false);expect(dealOptions.some(d=>d.unit?.complex_name==='Tower complex')).toBe(false);
  await expect(options('deals',20,plaza)).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
  const page=(await options('deals',10,plaza,'',1)).rows[0].result;expect(page.records).toHaveLength(1);expect(page.has_more).toBe(true);
  const next=(await options('deals',10,plaza,String(page.records[0].id),1)).rows[0].result;expect(next.records[0].id).not.toBe(page.records[0].id);
 });
 it('does not expose a write selector to a read-only project member',async()=>{
  await db.exec("UPDATE company_workspace_access SET write_sections='{}' WHERE user_id=20");
  expect((await options('context',20,tower)).rows[0].result.commands).toEqual([]);
  await expect(options('cash_desks',20,tower)).rejects.toThrow('WORKSPACE_OPTIONS_DENIED');
 });
});
