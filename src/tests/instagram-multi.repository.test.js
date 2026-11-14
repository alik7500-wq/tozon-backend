import {beforeEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({results:[],queries:[]}));
vi.mock('../db/connection.js',()=>({getServiceDB:()=>({from:table=>{
 const result=m.results.shift()||{data:[],error:null};const record={table,filters:[]};m.queries.push(record);
 const q={select:fields=>{record.fields=fields;return q;},eq:(key,value)=>{record.filters.push([key,value]);return q;},
 limit:()=>q,order:()=>q,maybeSingle:()=>q,upsert:(rows,options)=>{record.rows=rows;record.options=options;return q;},
 update:row=>{record.update=row;return q;},then:(resolve,reject)=>Promise.resolve(result).then(resolve,reject)};return q;
}})}));
vi.mock('../modules/integrations/social-token-crypto.js',()=>({encryptSocialToken:value=>'sealed:'+value,decryptSocialToken:value=>value.replace(/^sealed:/,'')}));
import {getInstagramInboxCredentials,getAllInstagramInboxCredentials,saveInstagramConnections,getTozonInstagramConnectionStatus,disconnectInstagramAccount} from '../modules/integrations/instagram-connection.repository.js';
const row=(id,extra={})=>({instagram_user_id:id,username:'profile'+id,encrypted_access_token:'sealed:token'+id,granted_scopes:['instagram_manage_messages'],...extra});
beforeEach(()=>{m.results.length=0;m.queries.length=0;});
it('requires an explicit account when more than one connection exists and filters selected credentials',async()=>{
 m.results.push({data:[row('11111'),row('22222')]});expect(await getInstagramInboxCredentials()).toBeNull();
 m.results.push({data:[row('22222')]});expect(await getInstagramInboxCredentials('22222')).toEqual({accountId:'22222',token:'token22222'});
 expect(m.queries[1].filters).toContainEqual(['instagram_user_id','22222']);
 expect(await getInstagramInboxCredentials('../me')).toBeNull();expect(m.queries).toHaveLength(2);
});
it('lists all usable credentials but never leaks encrypted or plaintext tokens into connection metadata',async()=>{
 m.results.push({data:[row('11111'),row('22222'),row('33333',{token_expires_at:'2000-01-01'})]});
 expect((await getAllInstagramInboxCredentials()).map(c=>c.accountId)).toEqual(['11111','22222']);
 m.results.push({data:[row('11111'),row('22222')]});const metadata=await getTozonInstagramConnectionStatus();
 expect(metadata.accounts).toHaveLength(2);expect(JSON.stringify(metadata)).not.toMatch(/sealed:|encrypted_access_token|token11111|token22222/);
});
it('atomically upserts only the authorized accounts without replacing any other connection',async()=>{
 await saveInstagramConnections([{instagramUserId:'11111',username:'first',accessToken:'one',grantedScopes:['instagram_manage_messages']},{instagramUserId:'22222',username:'second',accessToken:'two',grantedScopes:['instagram_manage_messages']}]);
 expect(m.queries).toHaveLength(2);expect(m.queries[0].options.onConflict).toBe('instagram_user_id');
 expect(m.queries[1]).toMatchObject({table:'crm_instagram_rollout',rows:[{account_id:'11111'},{account_id:'22222'}],options:{ignoreDuplicates:true}});
 expect(m.queries[0].rows.map(r=>r.encrypted_access_token)).toEqual(['sealed:one','sealed:two']);
 await expect(saveInstagramConnections([{instagramUserId:'33333',accessToken:'three',grantedScopes:[]}])).rejects.toThrow();expect(m.queries).toHaveLength(2);
});
it('disconnects exactly one account, erases its token and preserves history tables',async()=>{
 m.results.push({data:[{instagram_user_id:'22222'}]});expect(await disconnectInstagramAccount('22222')).toBe(true);
 expect(m.queries[0].filters).toContainEqual(['instagram_user_id','22222']);expect(m.queries[0].update.status).toBe('revoked');
 expect(m.queries[0].update.encrypted_access_token).toBe('sealed:disconnected');expect(m.queries[0].table).toBe('tozon_instagram_connections');
});
