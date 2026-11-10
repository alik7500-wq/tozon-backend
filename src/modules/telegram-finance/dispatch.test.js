vi.mock('../company-projects/workspace.background.js',()=>({assertLegacyAutomationAllowed:vi.fn().mockResolvedValue(undefined)}));
import {it,expect,vi} from 'vitest';
import {FinanceBot} from './bot.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function setup(rows,options={}) {
 const state=rows.map(r=>({...r,status:'PENDING'}));
 const repo={claimLease:vi.fn(async()=>true),pending:vi.fn(async()=>state.filter(x=>x.status==='PENDING')),
 claimUpdate:vi.fn(async id=>{const r=state.find(r=>r.update_id===id&&r.status==='PENDING');if(!r)return false;r.status='PROCESSING';return true;}),
 updateStatus:vi.fn(async(id,status)=>{state.find(r=>r.update_id===id).status=status;}),release:vi.fn()};
 const api={call:vi.fn(async()=>({})),send:vi.fn()};
 const bot=new FinanceBot(repo,api,{passport:{cleanup:vi.fn()},sync:vi.fn(),...options});bot.daily=vi.fn();
 return {bot,repo,state};
}
const item=(id,chat)=>({update_id:id,payload:{message:{chat:{id:chat,type:'private'},from:{id:chat},text:'test'}}});
it('does not make another manager wait for passport AI; preserves ordering in each chat',async()=>{
 const slow=deferred(),{bot,state}=setup([item(1,10),item(2,10),item(3,20)]);
 const order=[];bot.handle=vi.fn(async u=>{order.push(u.message.chat.id);if(order.length===1)await slow.promise;});
 await bot.tick();await flush();
 expect(order).toEqual([10,20]);expect(state.find(r=>r.update_id===3).status).toBe('DONE');expect(state.find(r=>r.update_id===2).status).toBe('PENDING');
 slow.resolve();await flush();
 expect(order).toEqual([10,20,10]);expect(state.every(r=>r.status==='DONE')).toBe(true);
 await bot.stop();
});
it('handles incoming messages while slow Google Sheets synchronization is running',async()=>{
 const sheets=deferred(),{bot,state}=setup([],{sync:vi.fn(()=>sheets.promise)});
 bot.handle=vi.fn();await bot.tick();await flush();expect(bot.sync).toHaveBeenCalledOnce();
 state.push({...item(1,10),status:'PENDING'});await bot.tick();await flush();
 expect(bot.handle).toHaveBeenCalledOnce();expect(state[0].status).toBe('DONE');
 sheets.resolve();await bot.stop();
});
it('immediately wakes after a webhook arrives during dispatch instead of waiting for the safety timer',async()=>{
 const gate=deferred(),{bot,repo,state}=setup([]);repo.pending.mockImplementationOnce(()=>gate.promise);
 bot.handle=vi.fn();const first=bot.tick();await flush();
 state.push({...item(1,10),status:'PENDING'});await bot.tick();gate.resolve([]);await first;await flush();
 expect(bot.handle).toHaveBeenCalledOnce();await bot.stop();
});
it('bounds concurrency and does not claim one chat twice on repeated webhook wakes',async()=>{
 const gate=deferred(),{bot,repo}=setup([item(1,10),item(2,20),item(3,30)],{maxConcurrentChats:2});
 bot.handle=vi.fn(()=>gate.promise);await bot.tick();await flush();await bot.tick();
 expect(bot.inFlight.size).toBe(2);expect(bot.handle).toHaveBeenCalledTimes(2);expect(repo.claimUpdate).toHaveBeenCalledTimes(2);
 gate.resolve();await flush();expect(bot.handle).toHaveBeenCalledTimes(3);await bot.stop();
});
it('does not handle an update unless its database claim succeeds',async()=>{
 const {bot,repo}=setup([item(1,10)]);repo.claimUpdate.mockResolvedValue(false);bot.handle=vi.fn();
 await bot.tick();await flush();expect(bot.handle).not.toHaveBeenCalled();await bot.stop();
});
it('finishes dispatch and active work before releasing ownership on shutdown',async()=>{
 const gate=deferred(),{bot,repo}=setup([item(1,10)]);repo.claimUpdate.mockImplementationOnce(async()=>{await gate.promise;return true;});
 bot.handle=vi.fn();const dispatch=bot.tick();await flush();const stopping=bot.stop();await flush();expect(repo.release).not.toHaveBeenCalled();
 gate.resolve();await dispatch;await stopping;expect(bot.handle).toHaveBeenCalledOnce();expect(repo.release).toHaveBeenCalledOnce();
});
it('processes different report buttons without silently dropping the second one',async()=>{
 const {bot,repo}=setup([]);repo.find=vi.fn(async()=>({telegram_id:'10',status:'APPROVED',slot:'AKMALKHON'}));
 bot.passport.handle=vi.fn(async()=>false);bot.report=vi.fn();
 await bot.handle({message:{from:{id:10},chat:{id:10,type:'private'},text:'/today'}});
 await bot.handle({message:{from:{id:10},chat:{id:10,type:'private'},text:'/month'}});
 expect(bot.report).toHaveBeenCalledTimes(2);await bot.stop();
});
