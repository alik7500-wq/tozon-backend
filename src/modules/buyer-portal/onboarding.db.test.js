import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
let db;const hash='a'.repeat(64),phone='+992900000001';
beforeAll(async()=>{
 db=new PGlite();await db.exec(readFileSync(new URL('./testing/crm-fixture.sql',import.meta.url),'utf8'));
 const directory=new URL('../../../supabase/migrations/',import.meta.url);
 for(const f of readdirSync(directory).filter(f=>f.includes('_buyer_portal_')).sort())await db.exec(readFileSync(new URL(f,directory),'utf8'));
},20000);
beforeEach(async()=>{
 await db.exec(`truncate buyer_portal_archives,buyer_portal_notices,buyer_portal_inquiries,buyer_portal_audit,buyer_portal_otp,buyer_portal_invites,buyer_portal_grants,buyer_portal_bindings,buyer_portal_participants,buyer_portal_documents,tasks cascade;
 delete from deals where id>2;update deals set lead_id=id,status='SIGNED',responsible_user_id=1;
 update users set role='ADMIN',is_active=1;delete from users where id>1;
 update leads set phone=case when id=1 then '${phone}' else '+992900000002' end;
 insert into deals select (jsonb_populate_record(null::deals,to_jsonb(d)||'{"id":3,"contract_number":"003"}'::jsonb)).* from deals d where id=1;`);
});
afterAll(async()=>{await db?.close();});
const list=async(actor=1)=>(await db.query('select buyer_portal_onboarding_list($1) value',[actor])).rows[0].value;
const prepare=async(request=randomUUID(),actor=1,expected=phone)=>(await db.query('select buyer_portal_prepare_sms_invite(1,$1,$2,$3,\'tj\',$4) value',[actor,hash,request,expected])).rows[0].value;
it('deduplicates two contracts into one buyer and lists only signed customers',async()=>{
 const rows=await list();expect(rows).toHaveLength(2);expect(rows.find(r=>r.leadId===1)).toMatchObject({contracts:2,status:'NOT_INVITED',canSend:true});
 await db.exec("update deals set status='RESERVED' where id=2");expect(await list()).toHaveLength(1);
});
it('prepares one seven-day invitation, never a grant, and prevents duplicate and repeated sends',async()=>{
 const id=randomUUID();expect((await prepare(id)).status).toBe('CREATED');expect((await prepare(id)).status).toBe('EXISTING');expect((await prepare()).status).toBe('RATE_LIMITED');
 const row=(await db.query('select expires_at-created_at duration,source from buyer_portal_invites')).rows[0];expect(row.source).toBe('SMS_INVITE');
 expect((await db.query('select count(*)::int n from buyer_portal_grants')).rows[0].n).toBe(0);
 expect((await list()).find(r=>r.leadId===1)).toMatchObject({status:'UNKNOWN',canSend:false});
});
it('retains short QR expiry and rejects SMS invitations over seven days',async()=>{
 await expect(db.query("insert into buyer_portal_invites(token_hash,deal_id,lead_id,owner_lead_id,phone_snapshot,created_by,expires_at) values($1,1,1,1,$2,1,now()+interval '1 hour')",[hash,phone])).rejects.toThrow();
 await prepare();await expect(db.exec("update buyer_portal_invites set expires_at=created_at+interval '8 days'")).rejects.toThrow();
});
it('supports the existing staff approval and reports PENDING then CONNECTED',async()=>{
 const created=await prepare();await db.exec("update buyer_portal_invites set sms_delivery_status='SENT',sms_sent_at=now()");
 expect((await list()).find(r=>r.leadId===1).status).toBe('INVITED');
 const claim=(await db.query('select buyer_portal_request_connection($1,101) r',[hash])).rows[0].r;
 expect(claim.status).toBe('PENDING');expect((await list()).find(r=>r.leadId===1).status).toBe('PENDING');
 await db.query('select buyer_portal_approve_connection($1,1,1,101,$2)',[created.id,claim.code]);
 expect((await list()).find(r=>r.leadId===1).status).toBe('CONNECTED');expect((await prepare()).status).toBe('CONNECTED');
});
it('rejects changed phones and enforces manager assignment and role',async()=>{
 expect((await prepare(randomUUID(),1,'+992900000009')).status).toBe('PHONE_CHANGED');
 await db.exec("insert into users(id,name,role,is_active) values(2,'Manager','SALES_MANAGER',1),(3,'Finance','FINANCE_MANAGER',1)");
 expect(await list(2)).toEqual([]);expect((await prepare(randomUUID(),2)).status).toBe('UNAVAILABLE');expect(await list(3)).toEqual([]);
 await db.exec('update deals set responsible_user_id=2 where id=1');expect(await list(2)).toHaveLength(1);expect((await prepare(randomUUID(),2)).status).toBe('CREATED');
});
it('denies anon/authenticated access to all new functions',async()=>{
 for(const role of ['anon','authenticated'])for(const fn of ['buyer_portal_onboarding_list(integer)','buyer_portal_prepare_sms_invite(integer,integer,text,uuid,text,text)'])
 expect((await db.query('select has_function_privilege($1,$2,\'execute\') allowed',[role,fn])).rows[0].allowed).toBe(false);
});
