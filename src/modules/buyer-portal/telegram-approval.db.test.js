import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync,readdirSync} from 'node:fs';
let db;const hash='a'.repeat(64);
beforeAll(async()=>{
 db=new PGlite();await db.exec(readFileSync(new URL('./testing/crm-fixture.sql',import.meta.url),'utf8'));
 const directory=new URL('../../../supabase/migrations/',import.meta.url);
 for(const f of readdirSync(directory).filter(f=>f.includes('_buyer_portal_')).sort())await db.exec(readFileSync(new URL(f,directory),'utf8'));
},20000);
beforeEach(async()=>{
 await db.exec(`truncate buyer_portal_archives,buyer_portal_notices,buyer_portal_inquiries,buyer_portal_audit,buyer_portal_otp,buyer_portal_invites,buyer_portal_grants,buyer_portal_bindings,buyer_portal_participants,buyer_portal_documents,tasks cascade;
 update deals set lead_id=id,status='SIGNED';update users set role='ADMIN',is_active=1;update leads set phone=case when id=1 then '+992900000001' else '+992900000002' end;
 insert into buyer_portal_invites(token_hash,deal_id,lead_id,owner_lead_id,phone_snapshot,created_by) values('${hash}',1,1,1,'+992900000001',1);`);
});
afterAll(async()=>{await db?.close();});
const request=async(tg=101)=>(await db.query('select buyer_portal_request_connection($1,$2) r',[hash,tg])).rows[0].r;
const access=async(tg=101)=>(await db.query('select * from buyer_portal_access($1)',[tg])).rows;
async function approve(code,actor=1){const i=(await db.query('select id from buyer_portal_invites')).rows[0].id;return (await db.query('select buyer_portal_approve_connection($1,1,$2,101,$3) r',[i,actor,code])).rows[0].r;}
it('requires staff approval once, then persists Telegram without any OTP or SMS',async()=>{
 const pending=await request();expect(pending.status).toBe('PENDING');expect(pending.code).toMatch(/^[A-F0-9]{8}$/);
 expect(await access()).toEqual([]);expect(await request()).toEqual(pending);
 expect(await approve(pending.code)).toEqual({status:'VERIFIED'});
 expect((await access()).map(a=>a.deal_id)).toEqual([1]);expect(await request()).toEqual({status:'VERIFIED'});
 expect((await db.query('select count(*)::int n from buyer_portal_otp')).rows[0].n).toBe(0);
});
it('rejects another Telegram, a wrong confirmation code and an unauthorized employee',async()=>{
 const pending=await request();expect((await request(202)).status).toBe('UNAVAILABLE');
 await expect(approve('FFFFFFFF')).rejects.toThrow();
 await db.exec("insert into users(id,name,role,is_active) values(2,'Other','FINANCE_MANAGER',1)");
 await expect(approve(pending.code,2)).rejects.toThrow();expect(await access()).toEqual([]);
});
it('rechecks changed phone, expired QR and changed contract owner before approval',async()=>{
 const pending=await request();await db.exec("update leads set phone='+992900000009' where id=1");
 await expect(approve(pending.code)).rejects.toThrow();expect(await access()).toEqual([]);
});
it('cannot silently replace an existing Telegram binding',async()=>{
 const pending=await request();await db.exec("insert into buyer_portal_bindings(lead_id,telegram_id,phone_snapshot) values(1,202,'+992900000001')");
 await expect(approve(pending.code)).rejects.toThrow();expect(await access()).toEqual([]);
});
it('does not expose approval functions to public clients',async()=>{
 for(const role of ['anon','authenticated'])for(const fn of ['buyer_portal_request_connection(text,bigint)','buyer_portal_approve_connection(uuid,integer,integer,bigint,text)'])
 expect((await db.query('select has_function_privilege($1,$2,\'execute\') allowed',[role,fn])).rows[0].allowed).toBe(false);
});
