import { describe,it,expect,vi,beforeEach } from 'vitest';
const state=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('../../db/connection.js',()=>({getServiceDB:()=>({rpc:state.rpc})}));
import { parseWorkspaceCommand,executeWorkspaceCommand } from './workspace.commands.js';
const req='00000000-0000-4000-8000-000000000009',project='00000000-0000-4000-8000-000000000010';
const good={request_id:req,kind:'PAYMENT',payload:{cash_desk_id:project,deal_id:1,amount_minor:12345,currency:'USD',date:'2026-11-10'}};
beforeEach(()=>vi.clearAllMocks());
describe('workspace command schema and database adapter',()=>{
 it.each([
  {...good,actor:999},
  {...good,payload:{...good.payload,status:'SIGNED'}},
  {...good,payload:{...good.payload,amount_minor:1.5}},
  {...good,payload:{...good.payload,amount_minor:-1}},
  {...good,payload:{...good.payload,date:'2026-02-30'}},
  {...good,kind:'SIGN_DEAL'},
  {...good,kind:'TRANSFER_CASH'},
  {...good,payload:{...good.payload,auto_convert:true}},
  {...good,request_id:'bad-key'},
 ])('rejects unsupported or forged command %#',input=>expect(()=>parseWorkspaceCommand(input)).toThrow());
 it('uses verified actor/project and one atomic RPC with the original request ID',async()=>{
  state.rpc.mockResolvedValue({data:{id:1,idempotent:false}});
  await executeWorkspaceCommand(10,project,parseWorkspaceCommand(good));
  expect(state.rpc).toHaveBeenCalledWith('execute_company_project_command',expect.objectContaining({p_actor:10,p_project:project,p_request:req,p_kind:'PAYMENT',p_payload:expect.objectContaining({amount_minor:12345})}));
 });
 it.each([['42501',403],['23505',409],['22023',400],['23514',400],['P0002',404]])('maps %s without exposing SQL internals',async(code,status)=>{
  state.rpc.mockResolvedValue({error:{code,message:'PRIVATE SQL DETAILS'}});
  try{await executeWorkspaceCommand(10,project,parseWorkspaceCommand(good));throw new Error('Expected rejection');}catch(e){expect(e.statusCode).toBe(status);expect(e.message).not.toContain('PRIVATE SQL DETAILS');}
 });
});
