import {describe,it,expect,vi} from 'vitest';
import {canScan,PassportBridge} from './service.js';
import {FinanceBot} from '../telegram-finance/bot.js';

describe('passport and finance isolation',()=>{
 it('requires active sales access, not finance access',()=>{
  expect(canScan({is_active:1,role:'SALES_MANAGER'})).toBe(true);
  expect(canScan({is_active:0,role:'ADMIN'})).toBe(false);
  expect(canScan({is_active:1,role:'FINANCE_MANAGER'})).toBe(false);
  expect(canScan({is_active:1,role:'SALES_MANAGER',permissions:['access.v2','deals.view']})).toBe(false);
  expect(canScan({is_active:1,role:'SALES_MANAGER',permissions:['access.v2','deals.view','deals.manage']})).toBe(true);
 });
 it('passport start never registers or queries a financial subscriber',async()=>{
  const repo={register:vi.fn(),find:vi.fn()},api={call:vi.fn()},passport={handle:vi.fn().mockResolvedValue(true)};
  const bot=new FinanceBot(repo,api,{passport});
  await bot.handle({message:{from:{id:7},chat:{id:7,type:'private'},text:'/start passport_test'}});
  expect(repo.register).not.toHaveBeenCalled();expect(repo.find).not.toHaveBeenCalled();
 });
 it.each(['cash:today','movement:today','rnew','main_menu','/report 2026-10-01'])('blocks a scanner-only manager from financial command %s',async command=>{
  const repo={find:vi.fn().mockResolvedValue(null),snapshot:vi.fn(),session:vi.fn()},api={call:vi.fn(),send:vi.fn()};
  const bot=new FinanceBot(repo,api,{passport:{handle:vi.fn().mockResolvedValue(false)}});
  await bot.handle({callback_query:{id:'cb',from:{id:7},data:command,message:{chat:{id:7,type:'private'}}}});
  expect(repo.snapshot).not.toHaveBeenCalled();expect(repo.session).not.toHaveBeenCalled();
  expect(api.send.mock.calls[0][1]).toContain('Доступ к финансовым отчётам закрыт');
 });
 it('binds every CRM session query to owner and expiry',async()=>{
  const q={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),gt:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:null})};
  const bridge=new PassportBridge({db:{from:()=>q}});
  await expect(bridge.owned('other-draft',{id:10,is_active:1,role:'SALES_MANAGER'})).rejects.toThrow('PASSPORT_SESSION_EXPIRED');
  expect(q.eq).toHaveBeenCalledWith('user_id',10);expect(q.gt).toHaveBeenCalledWith('expires_at',expect.any(String));
 });
 it('does not intercept non-private chats',async()=>{
  const bridge=new PassportBridge({db:{from:vi.fn()}}),api={call:vi.fn()};
  expect(await bridge.handle({message:{from:{id:7},chat:{id:-1,type:'group'},text:'/start passport_'+'a'.repeat(48)}},api)).toBe(false);
  expect(api.call).not.toHaveBeenCalled();
 });
 it('rejects photo before CRM approves pairing',async()=>{
  const s={id:'session',user_id:1,status:'PAIRING'};
  const q={select:()=>q,eq:()=>q,gt:()=>q,in:()=>q,order:()=>q,limit:()=>q,maybeSingle:async()=>({data:s})};
  const analyze=vi.fn(),api={call:vi.fn()};
  const bridge=new PassportBridge({db:{from:()=>q},users:{findById:async()=>({id:1,is_active:1,role:'SALES_MANAGER'})},analyze});
  await bridge.handle({message:{from:{id:7},chat:{id:7,type:'private'},photo:[{file_id:'x'}]}},api);
  expect(analyze).not.toHaveBeenCalled();expect(api.call.mock.calls[0][1].text).toContain('подтвердите подключение');
 });
});

it('transfers only a reviewed session to its CRM owner and consumes it once',async()=>{
 let row={id:'s',user_id:12,telegram_id:'7',status:'REVIEW',file_ids:[],result:{document:{document_number:'TEST000'}},expires_at:new Date(Date.now()+60000).toISOString()};
 const db={from:()=>{
  const filters=[];let patch;
  const q={select:()=>q,eq:(k,v)=>{filters.push(r=>r[k]===v);return q;},gt:(k,v)=>{filters.push(r=>r[k]>v);return q;},update:p=>{patch=p;return q;},maybeSingle:async()=>{
    if(!row||!filters.every(f=>f(row)))return {data:null};
    if(patch)row={...row,...patch};return {data:{...row}};
  }};return q;
 }};
 const owner={id:12,is_active:1,role:'SALES_MANAGER'};
 const bridge=new PassportBridge({db,users:{findById:async()=>owner}}),api={call:vi.fn()};
 expect((await bridge.status('s',owner)).result).toBeNull();
 await expect(bridge.status('s',{...owner,id:99})).rejects.toThrow('PASSPORT_SESSION_EXPIRED');
 await bridge.handle({callback_query:{id:'cb',from:{id:7},data:'passport:transfer:s',message:{chat:{id:7,type:'private'}}}},api);
 expect((await bridge.status('s',owner)).result.document.document_number).toBe('TEST000');
 expect(await bridge.consume('s',owner)).toBe(true);
 expect((await bridge.status('s',owner)).result).toBeNull();
 expect(await bridge.consume('s',owner)).toBe(false);
});

it('serves previews only to the session owner before consumption',async()=>{
 const bridge=new PassportBridge(),api={};
 bridge.owned=vi.fn().mockResolvedValue({status:'READY',file_ids:['photo-front','photo-back']});
 bridge.downloadPhoto=vi.fn().mockResolvedValue({buffer:Buffer.from('image'),mimeType:'image/jpeg'});
 await bridge.image('s',{id:12},1,api);
 expect(bridge.owned).toHaveBeenCalledWith('s',{id:12});
 expect(bridge.downloadPhoto).toHaveBeenCalledWith('photo-back',api);
 await expect(bridge.image('s',{id:12},2,api)).rejects.toThrow('PHOTO_UNAVAILABLE');
 bridge.owned.mockResolvedValue({status:'CONSUMED',file_ids:[]});
 await expect(bridge.image('s',{id:12},0,api)).rejects.toThrow('PHOTO_UNAVAILABLE');
});
