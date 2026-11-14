import {beforeEach,it,expect,vi} from 'vitest';
vi.mock('../../db/connection.js',()=>({getServiceDB:vi.fn()}));
import {BuyerIdentityService} from './identity.service.js';
const id='22222222-2222-4222-8222-222222222222',manager={id:7,role:'SALES_MANAGER',is_active:true},leader={...manager,role:'DIRECTOR'};
let service,repo;
beforeEach(()=>{
 repo={deal:vi.fn(async()=>({id:1,lead_id:1,status:'SIGNED',responsible_user_id:7,leads:{phone:'+992900000001'}})),lead:vi.fn(async()=>({id:2,phone:'+992900000002'})),participant:vi.fn(async()=>({id,lead_id:2,owner_lead_id:1})),
 createInvite:vi.fn(async()=>({id:'invite'})),addParticipant:vi.fn(async()=>id),revokeParticipant:vi.fn(),participants:vi.fn(async()=>[]),bindingStatus:vi.fn(async()=>({connected:true})),access:vi.fn(async()=>[{deal_id:1}]),archiveAccess:vi.fn(async()=>[{deal_id:2}]),contractSnapshot:vi.fn(async()=>null),archiveSnapshot:vi.fn(async()=>null),unlink:vi.fn()};
 service=new BuyerIdentityService({repo,botIdentity:async()=>({username:'ActualBot'}),otpSecret:()=> 'test-only-secret-at-least-32-characters'});
});
it('requires leadership and explicit verified evidence, then records the authenticated actor',async()=>{
 const body={leadId:2,role:'CO_BUYER',basis:'Signed agreement',verified:true};
 await expect(service.addParticipant(1,manager,body)).rejects.toThrow('BUYER_ACCESS_DENIED');
 await expect(service.addParticipant(1,leader,{...body,verified:false})).rejects.toThrow('BUYER_PARTICIPANT_INVALID');
 await expect(service.addParticipant(1,leader,body)).resolves.toEqual({id});expect(repo.addParticipant).toHaveBeenCalledWith(1,2,'CO_BUYER','Signed agreement',7);
});
it('issues participant QR only for the approved current-owner relationship and CRM phone',async()=>{
 await service.createInvite(1,manager,id);expect(repo.createInvite).toHaveBeenCalledWith(expect.objectContaining({lead_id:2,owner_lead_id:1,participant_id:id,phone_snapshot:'+992900000002'}));
 repo.participant.mockResolvedValueOnce(null);await expect(service.createInvite(1,manager,id)).rejects.toThrow('BUYER_ACCESS_DENIED');
 repo.participant.mockResolvedValueOnce({lead_id:2,owner_lead_id:9});await expect(service.createInvite(1,manager,id)).rejects.toThrow('BUYER_ACCESS_DENIED');
 repo.lead.mockResolvedValueOnce({id:2,phone:null});await expect(service.createInvite(1,manager,id)).rejects.toThrow('BUYER_PHONE_REQUIRES_STAFF_VERIFICATION');
});
it('shows archive access at entry but never creates a new invitation for a cancelled deal',async()=>{
 expect(await service.contracts('101')).toEqual([{deal_id:1},{deal_id:2,archived:true}]);
 repo.deal.mockResolvedValue({id:1,lead_id:1,status:'CANCELLED',responsible_user_id:7});
 await expect(service.createInvite(1,leader)).rejects.toThrow('BUYER_CONTRACT_UNAVAILABLE');
 await expect(service.staffStatus(1,manager)).resolves.toEqual({connected:true});
 await expect(service.revokeParticipant(1,manager,id)).rejects.toThrow('BUYER_ACCESS_DENIED');
 await service.revokeParticipant(1,leader,id);expect(repo.revokeParticipant).toHaveBeenCalledWith(1,id,7);
});
it('keeps archive lookup scoped to the verified Telegram identity and denies absent history',async()=>{
 await expect(service.contract('101',1)).rejects.toThrow('BUYER_CONTRACT_UNAVAILABLE');
 expect(repo.archiveSnapshot).toHaveBeenCalledWith('101',1);
});
it('rejects inactive or unassigned staff before returning participant or binding information',async()=>{
 await expect(service.participantList(1,{...manager,id:8})).rejects.toThrow('BUYER_ACCESS_DENIED');
 await expect(service.staffStatus(1,{...leader,is_active:false},id)).rejects.toThrow('BUYER_ACCESS_DENIED');
 expect(repo.participants).not.toHaveBeenCalled();expect(repo.bindingStatus).not.toHaveBeenCalled();
});
it('previews only a safe CRM name and masked phone for leadership',async()=>{
 repo.lead.mockResolvedValue({id:2,full_name:'Участник',phone:'+992900000002',passport:'SECRET'});
 await expect(service.participantCandidate(1,manager,2)).rejects.toThrow('BUYER_ACCESS_DENIED');
 expect(await service.participantCandidate(1,leader,2)).toEqual({id:2,name:'Участник',maskedPhone:'+992•••••0002'});
});
