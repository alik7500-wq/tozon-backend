import {it,expect,vi,afterEach} from 'vitest';
import {resolveInstagramAccounts,setInstagramWebhookSubscription} from '../modules/integrations/facebook-business-token.client.js';
const response=body=>({ok:true,json:async()=>body});
afterEach(()=>vi.unstubAllGlobals());
it('discovers multiple professional accounts using only the fixed Meta host and cursor',async()=>{
 const request=vi.fn().mockResolvedValueOnce(response({data:[{id:'91',access_token:'one',instagram_business_account:{id:'11111',username:'first'}},{id:'92'}],paging:{next:'https://untrusted.invalid/?access_token=secret',cursors:{after:'CURSOR'}}}))
 .mockResolvedValueOnce(response({data:[{id:'93',access_token:'two',instagram_business_account:{id:'22222',username:'second'}}]}));
 vi.stubGlobal('fetch',request);const accounts=await resolveInstagramAccounts('user-token');expect(accounts.map(a=>a.instagramUserId)).toEqual(['11111','22222']);
 expect(request.mock.calls[1][0].origin).toBe('https://graph.facebook.com');expect(request.mock.calls[1][0].searchParams.get('after')).toBe('CURSOR');
});
it('rejects missing or ambiguous professional account grants',async()=>{
 const p={id:'91',access_token:'one',instagram_business_account:{id:'11111'}};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response({data:[p,p]})));await expect(resolveInstagramAccounts('user')).rejects.toThrow('Ambiguous');
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response({data:[{id:'92'}]})));await expect(resolveInstagramAccounts('user')).rejects.toThrow('No authorized');
});
it('subscribes and unsubscribes the chosen Instagram account without revoking other app grants',async()=>{
 const request=vi.fn().mockResolvedValue(response({success:true}));
 await setInstagramWebhookSubscription({accountId:'22222',token:'two',request});
 expect(request.mock.calls[0][0]).toBe('https://graph.facebook.com/v25.0/22222/subscribed_apps');
 expect(request.mock.calls[0][1].body).toBe('subscribed_fields=messages');
 await setInstagramWebhookSubscription({accountId:'22222',token:'two',disconnect:true,request});expect(request.mock.calls[1][1].method).toBe('DELETE');
});
