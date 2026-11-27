import {describe,it,expect} from 'vitest';
import {buildImportPlan} from './company-project-import-plan.mjs';
const fixture=()=>({snapshot_at:'2026-11-26T00:00:00Z',counts:{users:1,deals:2},
 users:[{id:3,role:'ADMIN',is_active:1,permissions:['users.manage']}],
 complexes:[{id:3,code:'PLAZA'},{id:4,code:'PLAZA2'}],
 cash_desks:[{id:'a',code:'MAIN_CASHIER'},{id:'b',code:'TOZON_PLAZA_2_CASH'}],
 cross_scope_cash:[{status:'VOIDED',count:1},{status:'ACTIVE',count:2}],
 unlinked_deals:0,warehouses:[],stock_links:[]});
describe('offline legacy import preflight',()=>{
 it('does not reuse colliding demo identities or give active source admins access',()=>{
  const s=fixture(),before=structuredClone(s);
  const p=buildImportPlan(s,{users:[{id:3}],complexes:[{id:3}]});
  expect(p.users[0]).toMatchObject({numeric_id_collision:true,target_id:null,target_enabled:false,copy_credentials:false,copy_global_permissions:false});
  expect(p.complexes[0]).toMatchObject({numeric_id_collision:true,target_id:null,preserve_demo_history:true});
  expect(p.execution_ready).toBe(false);expect(s).toEqual(before);
 });
 it('preserves AB/VG accounting separation and distinguishes voided conflicts',()=>{
  const p=buildImportPlan(fixture(),{users:[],complexes:[]});
  expect(p.complexes.map(p=>p.accounting_scope)).toEqual(['AB','VG']);
  expect(p.cash_desks.map(p=>p.accounting_scope)).toEqual(['AB','VG']);
  expect(p.cross_scope_cash).toHaveLength(2);expect(p.active_cross_scope_count).toBe(2);
  expect(p.financial_policy.count_voided_in_balances).toBe(false);
  expect(p.financial_policy.preserve_transfer_and_conversion_groups).toBe(true);
 });
 it('refuses ambiguous input and leaves unknown project scope unresolved',()=>{
  expect(()=>buildImportPlan({},{})).toThrow('INCOMPLETE_INVENTORY');
  const s=fixture();s.users.push({...s.users[0]});
  expect(()=>buildImportPlan(s,{users:[],complexes:[]})).toThrow('DUPLICATE_ID');
  const other=fixture();other.complexes.push({id:99,code:'OTHER'});
  const p=buildImportPlan(other,{users:[],complexes:[]});
  expect(p.complexes[2].accounting_scope).toBe('UNRESOLVED');
  expect(p.cash_desks[0].accounting_scope).toBe('UNRESOLVED');
 });
});
