import {beforeEach,it,expect,vi} from 'vitest';
vi.mock('../../db/connection.js',()=>({getServiceDB:vi.fn()}));
import {BuyerCommunicationsService} from './communications.service.js';
const id='11111111-1111-4111-8111-111111111111';
let repo,identity,service;
beforeEach(()=>{
 repo={contact:vi.fn(async()=>({status:'ACCEPTED',id})),inquiries:vi.fn(async()=>[]),settings:vi.fn(async()=>({enabled:true,language:'tj'})),saveSettings:vi.fn(async()=>({enabled:false,language:'ru'})),reply:vi.fn(async()=> 'ANSWERED')};
 identity={contracts:vi.fn(async()=>[{deal_id:1}]),repo:{deal:vi.fn(async()=>({id:1,lead_id:2}))},assertStaff:vi.fn()};
 service=new BuyerCommunicationsService({repo,identity});
});
it('checks ownership and persists only the signed caller identity, own contract and validated text',async()=>{
 await expect(service.contact('101',{dealId:1,id,message:' Вопрос '})).resolves.toEqual({id});expect(repo.contact).toHaveBeenCalledWith('101',1,id,'Вопрос');
 await expect(service.contact('101',{dealId:2,id,message:'Чужой'})).rejects.toMatchObject({statusCode:403});expect(repo.contact).toHaveBeenCalledTimes(1);
});
it('validates IDs, message limits and retry throttling before exposing success',async()=>{
 await expect(service.contact('101',{dealId:1,id:'invalid',message:'x'})).rejects.toThrow('BUYER_INQUIRY_INVALID');
 await expect(service.contact('101',{dealId:1,id,message:'x'.repeat(2001)})).rejects.toThrow('BUYER_INQUIRY_INVALID');
 repo.contact.mockResolvedValue({status:'RATE_LIMITED'});await expect(service.contact('101',{dealId:1,id,message:'x'})).rejects.toMatchObject({statusCode:429});
});
it('keeps preference writes typed and denies settings when grant was revoked',async()=>{
 await service.saveSettings('101',{enabled:false,language:'ru'});expect(repo.saveSettings).toHaveBeenCalledWith('101',false,'ru');
 await expect(service.saveSettings('101',{enabled:'false'})).rejects.toThrow('BUYER_SETTINGS_INVALID');
 identity.contracts.mockResolvedValue([]);await expect(service.settings('101')).rejects.toMatchObject({statusCode:403});
});
it('requires assigned CRM write rights before a manager reply',async()=>{
 identity.assertStaff.mockImplementation(()=>{throw new Error('DENIED');});await expect(service.reply(1,{id:3},{id,message:'reply'})).rejects.toThrow('DENIED');expect(repo.reply).not.toHaveBeenCalled();
});
