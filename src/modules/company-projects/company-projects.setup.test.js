import {it,expect,vi,beforeEach} from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('../../db/connection.js',()=>({getServiceDB:()=>({rpc:m.rpc})}));
import {executeSetup} from './company-projects.setup.js';
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('JWT_SECRET','synthetic-setup-test-secret');m.rpc.mockResolvedValue({data:{id:10}});});
const base={request_id:'00000000-0000-4000-8000-000000000001',project_revision:2};
it('hashes credentials, keeps a stable secret-keyed retry fingerprint and never forwards plaintext',async()=>{
 const body={...base,kind:'CREATE_ACCOUNT',name:'Pilot',email:'PILOT@example.invalid',password:'valid-test-password',project_role:'MANAGER'};await executeSetup(3,'project',body);await executeSetup(3,'project',body);
 const a=m.rpc.mock.calls[0][1],b=m.rpc.mock.calls[1][1];expect(a.p_actor).toBe(3);expect(a.p_payload.email).toBe('pilot@example.invalid');expect(a.p_payload.password).toBeUndefined();expect(a.p_payload.password_hash).toMatch(/^\$2b\$12\$/);expect(a.p_payload.password_fingerprint).toBe(b.p_payload.password_fingerprint);expect(a.p_payload.password_hash).not.toBe(b.p_payload.password_hash);
});
it('rejects actor injection, unknown rights, weak passwords and unconfirmed ownership changes',async()=>{
 for(const body of [{...base,kind:'SET_ACCESS',user_id:10,revision:1,enabled:true,sections:['admin'],write_sections:[]},{...base,kind:'BIND_DEMO_DEAL',deal_id:1,expected_updated_at:'stamp',confirmed:false},{...base,kind:'CREATE_ACCOUNT',name:'Pilot',email:'p@example.invalid',password:'short',project_role:'MANAGER'},{...base,kind:'RESOURCE',resource:'cash_desks',id:null,name:'Cash',actor:99}])await expect(executeSetup(3,'project',body)).rejects.toMatchObject({statusCode:400});expect(m.rpc).not.toHaveBeenCalled();
});
