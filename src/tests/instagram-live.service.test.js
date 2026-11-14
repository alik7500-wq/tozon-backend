import { beforeEach, it, expect, vi } from 'vitest';
const m=vi.hoisted(()=>({list:vi.fn(),messages:vi.fn(),send:vi.fn(),threads:vi.fn(),history:vi.fn(),save:vi.fn(),block:vi.fn()}));
vi.mock('../modules/integrations/instagram-inbox.client.js',async original=>({...await original(),createInstagramInboxClient:()=>({conversations:m.list,messages:m.messages,send:m.send})}));
vi.mock('../modules/integrations/instagram-connection.repository.js',()=>({getAllInstagramInboxCredentials:vi.fn()}));
vi.mock('../modules/integrations/instagram-live.repository.js',()=>({liveInboxEnabled:()=>true,readInstagramThreads:m.threads,readInstagramHistory:m.history,saveInstagramThread:m.save,blockInstagramReply:m.block}));
import { createInstagramLiveInbox } from '../modules/integrations/instagram-live.service.js';
import { InboxError } from '../modules/integrations/instagram-inbox.client.js';
beforeEach(()=>{vi.clearAllMocks();m.save.mockResolvedValue({});m.block.mockResolvedValue();});
it('returns durable conversations without waiting for a slow Meta response and coalesces refreshes',async()=>{
 const list=[{contactId:'123',lastMessage:'cached'}];m.threads.mockResolvedValue(list);
 let finish;m.list.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const a=createInstagramLiveInbox({accountId:'a1',token:'fake'});
 expect((await a.conversations()).data).toEqual(list);expect((await a.conversations()).data).toEqual(list);expect(m.list).toHaveBeenCalledTimes(1);
 finish({data:[]});
});
it('returns stored message history while Meta is unavailable/in flight',async()=>{
 const data=[{message_id:'m',text_content:'Салом 😊'}];m.history.mockResolvedValue({data,syncedAt:'2026-01-01',nextCursor:null});
 let finish;m.messages.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const a=createInstagramLiveInbox({accountId:'a2',token:'fake'});
 expect((await a.messages('123')).data).toEqual(data);expect(m.messages).toHaveBeenCalledTimes(1);
 finish({data:[],nextCursor:null});
});
it('persists a confirmed send immediately and does not misreport persistence failure as an unsent message',async()=>{
 m.history.mockResolvedValue({lastInboundAt:'2026-01-01'});m.send.mockResolvedValue({messageId:'sent'});m.save.mockRejectedValue(new Error('offline'));
 const a=createInstagramLiveInbox({accountId:'a3',token:'fake'});const result=await a.send('123',' answer ');
 expect(result.saved).toBe(false);expect(result.message.text_content).toBe('answer');expect(result.message.is_echo).toBe(true);
 expect(m.send).toHaveBeenCalledWith('123',' answer ','2026-01-01');expect(m.send).toHaveBeenCalledTimes(1);
});
it('remembers a definitive Meta window refusal and avoids repeated sending until a new inbound',async()=>{
 m.history.mockResolvedValue({lastInboundAt:new Date().toISOString()});m.send.mockRejectedValue(new InboxError('INSTAGRAM_REPLY_WINDOW_CLOSED',409));
 const a=createInstagramLiveInbox({accountId:'a4',token:'fake'});
 await expect(a.send('123','answer')).rejects.toMatchObject({code:'INSTAGRAM_REPLY_WINDOW_CLOSED'});expect(m.block).toHaveBeenCalledWith('a4','123');
 m.history.mockResolvedValue({replyBlockedUntil:new Date(Date.now()+60000).toISOString()});
 await expect(a.send('123','answer')).rejects.toMatchObject({code:'INSTAGRAM_REPLY_WINDOW_CLOSED'});expect(m.send).toHaveBeenCalledTimes(1);
});
