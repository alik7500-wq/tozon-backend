import {beforeEach,it,expect,vi} from 'vitest';
vi.mock('../../db/connection.js',()=>({getServiceDB:vi.fn()}));
import {BuyerNotificationWorker,noticeText} from './notification-worker.js';
let repo,identity,api,worker;
const makeContext=(kind='PAYMENT')=>({id:'notice1',kind,sourceId:'1',telegramId:'101',dealId:1,contractNumber:'001',language:'tj',dueDate:'2026-11-21'});
const detail=()=>({id:1,warnings:[],history:[{id:1,kind:'PAYMENT',status:'ACTIVE',amountMinor:92600,currency:'TJS',date:'2026-11-14'}],summary:{currency:'USD',paidMinor:10000,remainingMinor:90000,firstPaymentDate:null,overdueMinor:0},schedules:[{dueDate:'2026-11-21',remainingMinor:10000,status:'UPCOMING'}]});
beforeEach(()=>{
 repo={candidates:vi.fn(async()=>[]),enqueue:vi.fn(),claim:vi.fn().mockResolvedValueOnce({id:'notice1',attempts:1}).mockResolvedValue(null),context:vi.fn(async()=>makeContext()),finish:vi.fn()};
 identity={contract:vi.fn(async()=>detail())};api={send:vi.fn(async()=>{})};
 worker=new BuyerNotificationWorker({repo,identity,api,enabled:()=>true,url:()=> 'https://example.test/buyer',clock:()=>new Date('2026-11-14T07:00:00Z'),logger:{warn:vi.fn()}});
});
it('sends in saved language with a tokenless cabinet link and no financial menu',async()=>{
 await worker.tick();expect(api.send).toHaveBeenCalledWith('101',expect.stringContaining('Шартнома: №001'),{inline_keyboard:[[{text:'Кабинетро кушодан',web_app:{url:'https://example.test/buyer'}}]]},{mainMenu:false});
 expect(repo.finish).toHaveBeenCalledWith('notice1',worker.id,'SENT');
 expect(noticeText({...makeContext(),language:'ru'})).toContain('Учтена оплата');
});
it('never sends if source/access/preferences are no longer valid',async()=>{
 repo.context.mockResolvedValue(null);await worker.tick();expect(api.send).not.toHaveBeenCalled();expect(repo.finish).toHaveBeenCalledWith('notice1',worker.id,'CANCELLED');
});
it('does no DB/API work while globally disabled',async()=>{
 worker.enabled=()=>false;await worker.tick();worker.start();expect(repo.claim).not.toHaveBeenCalled();expect(repo.candidates).not.toHaveBeenCalled();expect(api.send).not.toHaveBeenCalled();
});
it('marks ambiguous network errors UNKNOWN and never schedules an automatic duplicate',async()=>{
 api.send.mockRejectedValue(new Error('network timeout secret'));await worker.tick();
 expect(repo.finish).toHaveBeenCalledWith('notice1',worker.id,'UNKNOWN','DELIVERY_UNCERTAIN');expect(api.send).toHaveBeenCalledTimes(1);
});
it('retries only a definite Telegram 429 rejection with bounded delay',async()=>{
 api.send.mockRejectedValue({code:429,retryAfter:15});await worker.tick();expect(repo.finish).toHaveBeenCalledWith('notice1',worker.id,'PENDING','TELEGRAM_429',15);
});
it('does not resend if Telegram accepted but the SENT acknowledgement could not be saved',async()=>{
 repo.finish.mockRejectedValue(new Error('DB unavailable'));await worker.tick();expect(api.send).toHaveBeenCalledTimes(1);expect(worker.logger.warn).toHaveBeenCalled();
});
it('collects 7/3/day reminders using current FIFO and deduplicated due-date keys',async()=>{
 repo.candidates.mockResolvedValue([{telegramId:'101',dealId:1}]);repo.claim.mockReset().mockResolvedValue(null);
 identity.contract.mockResolvedValue({...detail(),schedules:[{dueDate:'2026-11-21',remainingMinor:100,status:'UPCOMING'},{dueDate:'2026-11-17',remainingMinor:200,status:'UPCOMING'},{dueDate:'2026-11-14',remainingMinor:300,status:'UPCOMING'},{dueDate:'2026-11-14',remainingMinor:400,status:'UPCOMING'}]});
 await worker.tick();expect(repo.enqueue.mock.calls).toEqual([[1,'REMINDER_7','REMINDER_7:1:2026-11-21','2026-11-21'],[1,'REMINDER_3','REMINDER_3:1:2026-11-17','2026-11-17'],[1,'REMINDER_0','REMINDER_0:1:2026-11-14','2026-11-14']]);
});
it('does not send a queued reminder after payment closes its remaining amount',async()=>{
 repo.context.mockResolvedValue(makeContext('REMINDER_7'));identity.contract.mockResolvedValue({...detail(),schedules:[{dueDate:'2026-11-21',remainingMinor:0,status:'PAID'}]});
 await worker.tick();expect(api.send).not.toHaveBeenCalled();expect(repo.finish).toHaveBeenCalledWith('notice1',worker.id,'CANCELLED');
});
it('does not invent reminders while the schedule needs review or before the agreed first date',async()=>{
 repo.candidates.mockResolvedValue([{telegramId:'101',dealId:1}]);repo.claim.mockReset().mockResolvedValue(null);
 identity.contract.mockResolvedValue({...detail(),warnings:['SCHEDULE_REVIEW_REQUIRED']});await worker.tick();expect(repo.enqueue).not.toHaveBeenCalled();
 identity.contract.mockResolvedValue({...detail(),summary:{firstPaymentDate:'2026-12-01',overdueMinor:0},schedules:[{dueDate:'2026-11-14',remainingMinor:10000,status:'UPCOMING'}]});await worker.tick();expect(repo.enqueue).not.toHaveBeenCalled();
});
it('does not duplicate worker runs and waits for in-flight work during shutdown',async()=>{
 let finish;api.send.mockImplementation(()=>new Promise(r=>{finish=r;}));
 const tick=worker.tick();await vi.waitFor(()=>expect(api.send).toHaveBeenCalledOnce());
 expect(worker.tick()).toBe(tick);const stop=worker.stop();finish();await stop;await tick;
 expect(api.send).toHaveBeenCalledTimes(1);
});

it('formats a confirmed payment in its actual currency and totals in the contract currency',async()=>{
 await worker.tick();const text=api.send.mock.calls[0][1];expect(text).toContain('926 TJS');expect(text).toContain('100 USD');expect(text).toContain('900 USD');expect(text).toContain('2026-11-14');
});
it('cancels a payment notice if access/source changes during financial verification',async()=>{
 repo.context.mockResolvedValueOnce(makeContext()).mockResolvedValue(null);await worker.tick();expect(api.send).not.toHaveBeenCalled();
});
