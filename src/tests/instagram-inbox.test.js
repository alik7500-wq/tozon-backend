import { describe, it, expect, vi, afterEach } from 'vitest';
import { createInstagramInboxClient, inboxCursor } from '../modules/integrations/instagram-inbox.client.js';
const accountId = '17841447499018452', contact = '999', token = 'secret-test-token';
const page = { id: '123', instagram_business_account: { id: accountId } };
const conversation = { data: [{ id: 't_abc', participants: { data: [{ id: accountId }, { id: contact, username: 'customer' }] } }] };
const response = body => ({ ok: true, json: async () => body });
const client = (results, now = Date.now()) => {
 const request = vi.fn(); results.forEach(r => request.mockResolvedValueOnce(response(r)));
 return { api: createInstagramInboxClient({accountId, token, request, now: () => now}), request };
};
afterEach(() => vi.restoreAllMocks());
describe('Instagram Direct Graph adapter', () => {
 it('validates the Page token identity before reading private conversations', async () => {
  const {api,request}=client([{id:'123',instagram_business_account:{id:'wrong'}}]);
  await expect(api.conversations()).rejects.toMatchObject({code:'INSTAGRAM_ACCOUNT_MISMATCH'});
  expect(request).toHaveBeenCalledTimes(1);
 });
 it('projects only frontend fields and keeps tokens and paging URLs private', async () => {
  const {api,request}=client([page,{data:[{...conversation.data[0],messages:{data:[{message:'Hello'}]}}],paging:{next:'https://evil.example/?access_token=secret',cursors:{after:'CURSOR'}}}]);
  const result=await api.conversations();
  expect(result).toEqual({data:[{instagramAccountId:accountId,contactId:contact,name:'customer',lastMessage:'Hello',updatedAt:null}],nextCursor:'CURSOR'});
  expect(JSON.stringify(result)).not.toContain(token);
  expect(request.mock.calls[1][0].origin).toBe('https://graph.facebook.com');
  expect(request.mock.calls[1][1].headers.Authorization).toBe('Bearer '+token);
 });
 it('rejects foreign conversations even if Graph returns an unrelated participant', async () => {
  const {api,request}=client([page,{data:[{id:'t_foreign',participants:{data:[{id:'777'}]}}]}]);
  await expect(api.messages(contact)).rejects.toMatchObject({code:'INSTAGRAM_CONVERSATION_NOT_FOUND'});
  expect(request).toHaveBeenCalledTimes(2);
 });
 it('returns incoming and outgoing messages in chronological order', async () => {
  const {api}=client([page,conversation,{data:[{id:'b',from:{id:'123'},message:'answer',created_time:'2026-11-12T01:00:00Z'},{id:'a',from:{id:contact},message:'question',created_time:'2026-11-12T00:00:00Z'}]}]);
  const result=await api.messages(contact);
  expect(result.data.map(m=>m.message_id)).toEqual(['a','b']);
  expect(result.data.map(m=>m.is_echo)).toEqual([false,true]);
  expect(JSON.stringify(result)).not.toContain('senderId');
 });
 it('never sends when recent history contains only outgoing or old incoming messages', async () => {
  const {api,request}=client([page,conversation,{data:[{id:'a',from:{id:contact},created_time:'2026-11-10T00:00:00Z'},{id:'b',from:{id:'123'},created_time:'2026-11-12T01:00:00Z'}]}],Date.parse('2026-11-12T02:00:00Z'));
  await expect(api.send(contact,'answer')).rejects.toMatchObject({code:'INSTAGRAM_REPLY_WINDOW_CLOSED'});
  expect(request.mock.calls.every(([,o])=>o.method==='GET')).toBe(true);
 });
 it('verifies incoming window and sends exactly once to the owned Page', async () => {
  const {api,request}=client([page,conversation,{data:[{id:'a',from:{id:contact},created_time:'2026-11-12T01:00:00Z'}]},{message_id:'sent'}],Date.parse('2026-11-12T02:00:00Z'));
  await expect(api.send(contact,' answer ')).resolves.toEqual({messageId:'sent'});
  const sends=request.mock.calls.filter(([,o])=>o.method==='POST');
  expect(sends).toHaveLength(1); expect(sends[0][0].pathname).toBe('/v25.0/123/messages');
  expect(JSON.parse(sends[0][1].body)).toEqual({recipient:{id:contact},message:{text:'answer'},messaging_type:'RESPONSE'});
 });
 it('does not retry ambiguous sends or expose raw errors', async () => {
  const {api,request}=client([page,conversation,{data:[{id:'a',from:{id:contact},created_time:'2026-11-12T01:00:00Z'}]}],Date.parse('2026-11-12T02:00:00Z'));
  request.mockRejectedValueOnce(new Error('secret URL '+token));
  await expect(api.send(contact,'answer')).rejects.toMatchObject({code:'INSTAGRAM_SEND_UNCONFIRMED'});
  expect(request).toHaveBeenCalledTimes(4);
 });
 it('does not expose Meta free-form permission errors', async () => {
  const request=vi.fn().mockResolvedValue({ok:false,json:async()=>({error:{code:200,message:token}})});
  const api=createInstagramInboxClient({accountId,token,request});
  await expect(api.conversations()).rejects.toMatchObject({code:'INSTAGRAM_PERMISSION_REQUIRED'});
 });
 it('rejects invalid ids, text and pagination input', async () => {
  const {api,request}=client([]);
  await expect(api.send(contact,'x'.repeat(1001))).rejects.toMatchObject({status:400});
  await expect(api.messages('../me')).rejects.toMatchObject({status:400});
  expect(()=>inboxCursor('https://evil/')).toThrow();
  expect(request).not.toHaveBeenCalled();
 });
});
