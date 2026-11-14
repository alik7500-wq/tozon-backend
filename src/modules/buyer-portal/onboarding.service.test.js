import {beforeEach,it,expect,vi} from 'vitest';
import {BuyerOnboardingService,invitationText} from './onboarding.service.js';
const user={id:1,role:'ADMIN',is_active:true},row={leadId:1,name:'Buyer',phone:'+992900000001',dealId:1,contracts:2,status:'NOT_INVITED',canSend:true};
const body={leadId:1,requestId:'11111111-1111-4111-8111-111111111111',language:'tj',expectedPhone:row.phone};
let repo,sms,service;
beforeEach(()=>{repo={onboardingList:vi.fn(async()=>[row]),prepareSmsInvite:vi.fn(async()=>({status:'CREATED',id:'invite',dealId:1})),finishSmsInvite:vi.fn()};sms={sendSms:vi.fn(async()=>({success:true,data:{isMock:false}}))};service=new BuyerOnboardingService({repo,sms,botIdentity:async()=>({username:'TozonFinanceBot'}),enabled:()=>true});});
it('previews Tajik or Russian without creating an invitation or calling Payom',async()=>{
 const list=await service.preview(user,{leadIds:[1],language:'tj'});expect(list[0]).toMatchObject({leadId:1,phone:row.phone,language:'tj'});expect(list[0].text).toContain('Кабинети шахсии');expect(list[0].segments).toBeLessThanOrEqual(6);
 expect(invitationText('ru','LINK')).toContain('личный кабинет');expect(repo.prepareSmsInvite).not.toHaveBeenCalled();expect(sms.sendSms).not.toHaveBeenCalled();
});
it('sends one personalized long invitation with SMS history context',async()=>{
 expect(await service.send(user,body)).toMatchObject({status:'SENT'});expect(sms.sendSms).toHaveBeenCalledWith(expect.objectContaining({clientId:1,phone:row.phone,language:'tj',dealId:1,userId:1,text:expect.stringMatching(/https:\/\/t.me\/TozonFinanceBot\?start=buyer_[A-Za-z0-9_-]{43}/)}));expect(repo.finishSmsInvite).toHaveBeenCalledWith('invite','SENT');
});
it.each(['EXISTING','CONNECTED','PENDING','RATE_LIMITED','PHONE_CHANGED'])('never resends when preparation returns %s',async status=>{
 repo.prepareSmsInvite.mockResolvedValue({status});expect(await service.send(user,body)).toMatchObject({status});expect(sms.sendSms).not.toHaveBeenCalled();
});
it('records unknown acknowledgments without retry and never marks mocks sent',async()=>{
 sms.sendSms.mockRejectedValueOnce(new Error('network'));expect(await service.send(user,body)).toMatchObject({status:'UNKNOWN'});expect(sms.sendSms).toHaveBeenCalledTimes(1);
 sms.sendSms.mockResolvedValueOnce({success:true,data:{isMock:true}});expect(await service.send(user,body)).toMatchObject({status:'FAILED'});
});
it('rejects unauthorized roles, duplicate recipients, oversized batches and missing language',async()=>{
 await expect(service.list({...user,role:'FINANCE_MANAGER'})).rejects.toThrow('BUYER_ACCESS_DENIED');
 for(const value of [{leadIds:[1,1],language:'tj'},{leadIds:Array.from({length:11},(_,i)=>i),language:'tj'},{leadIds:[1]}])await expect(service.preview(user,value)).rejects.toThrow();expect(sms.sendSms).not.toHaveBeenCalled();
});
