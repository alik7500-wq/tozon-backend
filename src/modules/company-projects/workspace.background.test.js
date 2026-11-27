import {beforeEach,it,expect,vi} from 'vitest';
const mock=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('../../db/connection.js',()=>({getServiceDB:()=>({rpc:mock.rpc})}));
import {assertLegacyAutomationAllowed} from './workspace.background.js';
import {PayomSmsProvider} from '../sms/sms.provider.js';
import {SmsEventsService} from '../sms/smsEvents.service.js';
import {DealsRepository} from '../deals/deals.repository.js';
import {SmsService} from '../sms/sms.service.js';
import {TelegramAPI} from '../telegram-finance/bot.js';
import {syncSheets} from '../telegram-finance/sheets-sync.js';
beforeEach(()=>{vi.clearAllMocks();mock.rpc.mockResolvedValue({data:false});});
it('allows only a definite negative result and fails closed on unavailable or malformed ownership checks',async()=>{
 await assertLegacyAutomationAllowed({deal_id:9});expect(mock.rpc).toHaveBeenCalledWith('company_project_background_blocked',{p_context:{deal_id:9}});
 for(const result of [{data:true},{error:{message:'Unavailable'}},{data:null},{data:'false'}]){mock.rpc.mockResolvedValue(result);await expect(assertLegacyAutomationAllowed({deal_id:1})).rejects.toThrow();}
});
it('prevents provider transport even with valid credentials when the phone belongs to a project',async()=>{
 mock.rpc.mockResolvedValue({data:true});const fetchFn=vi.fn();const provider=new PayomSmsProvider({token:'unit-test-only',fetchFn});await expect(provider.sendSms({phone:'+992000000001',text:'No send'})).rejects.toMatchObject({code:'PROJECT_AUTOMATION_HELD'});expect(fetchFn).not.toHaveBeenCalled();
});
it('prevents the SMS service from reaching the provider or resolving a template for a held source',async()=>{
 mock.rpc.mockResolvedValue({data:true});const provider={sendSms:vi.fn()};const service=new SmsService(provider);const resolve=vi.spyOn(service,'resolveTemplate');await expect(service.sendSms({dealId:1,clientId:1,phone:'+992000000001',text:'No send'})).rejects.toMatchObject({code:'PROJECT_AUTOMATION_HELD'});expect(provider.sendSms).not.toHaveBeenCalled();expect(resolve).not.toHaveBeenCalled();
});

it('blocks shared Telegram and Sheets transports before any external network call',async()=>{
 mock.rpc.mockResolvedValue({data:true});const transport=vi.fn();await expect(new TelegramAPI('synthetic',transport).call('sendMessage',{text:'No send'})).rejects.toMatchObject({code:'PROJECT_AUTOMATION_HELD'});expect(transport).not.toHaveBeenCalled();
 vi.stubEnv('TOZON_SHEETS_WEBHOOK_URL','https://script.google.com/macros/s/SYNTHETIC/exec');vi.stubEnv('TOZON_SHEETS_SECRET','x'.repeat(32));const repo={sheetJobs:vi.fn()};await expect(syncSheets(repo,transport)).rejects.toMatchObject({code:'PROJECT_AUTOMATION_HELD'});expect(repo.sheetJobs).not.toHaveBeenCalled();expect(transport).not.toHaveBeenCalled();vi.unstubAllEnvs();
});

it('rejects a missing or cancelled schedule before the outbox can render or send it',async()=>{
 const lookup=vi.spyOn(DealsRepository,'getDealById');const service=new SmsEventsService({});
 for(const schedules of [[],[{id:1,status:'CANCELLED',amount_minor:10000,paid_amount_minor:0}]]){
  lookup.mockResolvedValue({id:9,status:'SIGNED',schedules});await expect(service.validateEventContext({event_type:'TEST',deal_id:9,schedule_id:1})).rejects.toMatchObject({code:'SCHEDULE_CANCELLED'});
 }
 lookup.mockRestore();
});
