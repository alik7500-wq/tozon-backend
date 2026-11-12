import {describe,it,expect,vi} from 'vitest';
import {createInstagramInboxClient,createInstagramLookupCache} from '../modules/integrations/instagram-inbox.client.js';
const accountId='17841447499018452',token='test-token',contact='999';
const page={id:'123',instagram_business_account:{id:accountId}};
const conversation={id:'t_abc',participants:{data:[{id:accountId},{id:contact}]}};
const response=body=>({ok:true,json:async()=>body});
const requestFor=(...bodies)=>{const request=vi.fn();bodies.forEach(b=>request.mockResolvedValueOnce(response(b)));return request;};
describe('verified Instagram lookup cache',()=>{
 it('uses one Graph call to open a conversation after listing it',async()=>{
  const cache=createInstagramLookupCache();const request=requestFor(page,{data:[conversation]},{data:[{id:'m',from:{id:contact},message:'hello'}]});
  await createInstagramInboxClient({accountId,token,request,cache}).conversations();
  const result=await createInstagramInboxClient({accountId,token,request,cache}).messages(contact);
  expect(result.data[0].text_content).toBe('hello');expect(request).toHaveBeenCalledTimes(3);
  expect(request.mock.calls[2][0].pathname).toBe('/v25.0/t_abc/messages');
 });
 it('expires verified identifiers and performs all checks again',async()=>{
  let time=1000;const cache=createInstagramLookupCache({ttlMs:60});const request=requestFor(page,{data:[conversation]},page,{data:[conversation]},{data:[]});
  const options={accountId,token,request,cache,now:()=>time};
  await createInstagramInboxClient(options).conversations();time+=61;
  await createInstagramInboxClient(options).messages(contact);expect(request).toHaveBeenCalledTimes(5);
 });
 it('never shares a verified mapping with a rotated token or different account',async()=>{
  const cache=createInstagramLookupCache();const first=requestFor(page,{data:[conversation]});
  await createInstagramInboxClient({accountId,token,request:first,cache}).conversations();
  const second=requestFor(page,{data:[]});
  await expect(createInstagramInboxClient({accountId,token:'rotated',request:second,cache}).messages(contact)).rejects.toMatchObject({code:'INSTAGRAM_CONVERSATION_NOT_FOUND'});
  expect(second).toHaveBeenCalledTimes(2);
  const third=requestFor(page);
  await expect(createInstagramInboxClient({accountId:'another',token,request:third,cache}).messages(contact)).rejects.toMatchObject({code:'INSTAGRAM_ACCOUNT_MISMATCH'});
 });
 it('clears cached identifiers after Meta rejects a message read',async()=>{
  const cache=createInstagramLookupCache();const request=requestFor(page,{data:[conversation]});
  await createInstagramInboxClient({accountId,token,request,cache}).conversations();
  request.mockResolvedValueOnce({ok:false,json:async()=>({error:{code:190}})});
  await expect(createInstagramInboxClient({accountId,token,request,cache}).messages(contact)).rejects.toMatchObject({code:'INSTAGRAM_RECONNECT_REQUIRED'});
  request.mockResolvedValueOnce(response(page)).mockResolvedValueOnce(response({data:[]}));
  await expect(createInstagramInboxClient({accountId,token,request,cache}).messages(contact)).rejects.toMatchObject({code:'INSTAGRAM_CONVERSATION_NOT_FOUND'});
  expect(request).toHaveBeenCalledTimes(5);
 });
 it('always revalidates identity and contact before sending, even with warm cache',async()=>{
  const cache=createInstagramLookupCache();const request=requestFor(page,{data:[conversation]},page,{data:[]});
  await createInstagramInboxClient({accountId,token,request,cache}).conversations();
  await expect(createInstagramInboxClient({accountId,token,request,cache}).send(contact,'answer')).rejects.toMatchObject({code:'INSTAGRAM_CONVERSATION_NOT_FOUND'});
  expect(request).toHaveBeenCalledTimes(4);expect(request.mock.calls.every(([,o])=>o.method==='GET')).toBe(true);
 });
 it('bounds memory and ignores expired values',()=>{
  const cache=createInstagramLookupCache({maxEntries:2,ttlMs:10});cache.set('one','1',0);cache.set('two','2',0);cache.set('three','3',0);
  expect(cache.get('one',1)).toBeUndefined();expect(cache.get('two',1)).toBe('2');expect(cache.get('two',10)).toBeUndefined();
 });
});
