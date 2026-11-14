import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {projectBuyerArchive} from './financial-projection.js';
let db;
const binding='11111111-1111-4111-8111-111111111111';
beforeAll(async()=>{
 db=new PGlite();await db.exec(readFileSync(new URL('./testing/crm-fixture.sql',import.meta.url),'utf8'));
 const directory=new URL('../../../supabase/migrations/',import.meta.url);
 for(const f of readdirSync(directory).filter(f=>f.includes('_buyer_portal_')).sort())await db.exec(readFileSync(new URL(f,directory),'utf8'));
},20000);
beforeEach(async()=>{
 await db.exec(`truncate buyer_portal_archives,buyer_portal_notices,buyer_portal_inquiries,buyer_portal_audit,buyer_portal_otp,buyer_portal_invites,buyer_portal_grants,buyer_portal_bindings,buyer_portal_participants,buyer_portal_documents,tasks cascade;
 update deals set lead_id=id,status='SIGNED',terminated_by_user_id=null,refund_expense_id=null;update leads set phone=case when id=1 then '+992900000001' else '+992900000002' end;
 update users set role='ADMIN';update payments set amount_minor=10000 where id=1;
 insert into buyer_portal_bindings(id,lead_id,telegram_id,phone_snapshot) values('${binding}',1,101,'+992900000001');
 insert into buyer_portal_grants(binding_id,deal_id,owner_lead_id) values('${binding}',1,1);
 delete from expenses;`);
});
afterAll(async()=>{await db?.close();});
const access=async(tg=101)=>(await db.query('select * from buyer_portal_access($1)',[tg])).rows;
const archived=async(tg=101)=>(await db.query('select buyer_portal_archive_snapshot($1,1) value',[tg])).rows[0].value;
const participant=async()=>(await db.query("select buyer_portal_participant_add(1,2,'CO_BUYER','Verified signed agreement',1) id")).rows[0].id;
const terminate=()=>db.exec("update deals set status='CANCELLED',terminated_by_user_id=1,cancelled_at=now() where id=1");
async function connect(id){
 const hash='a'.repeat(64),challenge=randomUUID();
 await db.query("insert into buyer_portal_invites(token_hash,deal_id,lead_id,owner_lead_id,participant_id,phone_snapshot,created_by) values($1,1,2,1,$2,'+992900000002',1)",[hash,id]);
 const prepared=(await db.query('select buyer_portal_prepare_otp($1,202,$2,$3) value',[hash,challenge,'b'.repeat(64)])).rows[0].value;
 expect(prepared).toMatchObject({status:'PREPARED',phone:'+992900000002'});
 await db.query('update buyer_portal_otp set delivered_at=now() where id=$1',[challenge]);
 return (await db.query('select buyer_portal_confirm_otp($1,202,$2) value',[challenge,'b'.repeat(64)])).rows[0].value;
}
it('requires an approved relationship plus participant phone OTP, never same-phone inference',async()=>{
 await db.exec("update leads set phone='+992900000001' where id=2");expect(await access(202)).toEqual([]);await db.exec("update leads set phone='+992900000002' where id=2");
 const id=await participant();expect(await access(202)).toEqual([]);expect(await connect(id)).toMatchObject({status:'VERIFIED'});
 expect((await access(202)).map(a=>a.deal_id)).toEqual([1]);
 const grants=(await db.query('select owner_lead_id,participant_id from buyer_portal_grants where participant_id is not null')).rows;
 expect(grants).toEqual([{owner_lead_id:1,participant_id:id}]);
 const list=(await db.query('select buyer_portal_contracts(202) value')).rows[0].value;expect(list.map(d=>d.id)).toEqual([1]);
});
it('blocks forged, revoked and wrong-owner participant invitations before SMS',async()=>{
 const id=await participant();await db.query('select buyer_portal_participant_revoke(1,$1,1)',[id]);
 const hash='a'.repeat(64);await db.query("insert into buyer_portal_invites(token_hash,deal_id,lead_id,owner_lead_id,participant_id,phone_snapshot,created_by) values($1,1,2,1,$2,'+992900000002',1)",[hash,id]);
 expect((await db.query('select buyer_portal_visit($1,202) value',[hash])).rows[0].value).toBe(false);
 expect((await db.query('select buyer_portal_prepare_otp($1,202,$2,$3) value',[hash,randomUUID(),'b'.repeat(64)])).rows[0].value.status).toBe('UNAVAILABLE');
});
it('revokes a participant immediately without disconnecting the main buyer or other contracts',async()=>{
 const id=await participant();await connect(id);await db.query('select buyer_portal_participant_revoke(1,$1,1)',[id]);
 expect(await access(202)).toEqual([]);expect(await access()).toHaveLength(1);
});
it('queues payment notices for each separately verified participant, not unconnected contacts',async()=>{
 const id=await participant();await connect(id);
 await db.exec("insert into payments(id,deal_id,amount_minor,currency,payment_date,status) values(3,1,5000,'USD','2026-11-14','ACTIVE')");
 const recipients=(await db.query('select b.telegram_id::text tg from buyer_portal_notices n join buyer_portal_bindings b on b.id=n.binding_id order by tg')).rows;
 expect(recipients).toEqual([{tg:'101'},{tg:'202'}]);await db.exec('delete from payments where id=3');
});
it('freezes history and refund at actual termination without exposing future payments or property materials',async()=>{
 const id=await participant();await connect(id);
 await db.exec("insert into expenses(id,amount_minor,currency,status,expense_date) values(1,3000,'USD','ACTIVE','2026-11-14');update deals set refund_expense_id=1 where id=1");
 await terminate();expect(await access()).toEqual([]);expect(await access(202)).toEqual([]);
 const snapshot=await archived();expect(snapshot.deal.status).toBe('CANCELLED');expect(snapshot.refund.amount_minor).toBe(3000);
 const result=projectBuyerArchive(snapshot);expect(result).toMatchObject({archived:true,status:'CANCELLED',summary:{paidMinor:7000,remainingMinor:null,overdueMinor:null,nextPayment:null},schedules:[]});
 await db.exec('update payments set amount_minor=50000 where id=1');expect((await archived()).payments[0].amount_minor).toBe(10000);
 expect(await archived(202)).not.toBeNull();expect(await archived(303)).toBeNull();
 const list=(await db.query('select buyer_portal_contracts(101) value')).rows[0].value;expect(list[0]).toMatchObject({id:1,archived:true,status:'CANCELLED'});
 const materials=(await db.query('select buyer_portal_materials(101,1) value')).rows[0].value;expect(materials).toEqual({plan2d:null,plan3d:null,tour:null,documents:[]});
});
it('does not archive cancellation without actual termination metadata or resurrect access after owner/status reversal',async()=>{
 await db.exec("update deals set status='CANCELLED' where id=1");expect(await archived()).toBeNull();
 await db.exec("update deals set status='SIGNED' where id=1;insert into buyer_portal_grants(binding_id,deal_id,owner_lead_id) values('"+binding+"',1,1)");await terminate();expect(await archived()).not.toBeNull();
 await db.exec("update deals set status='SIGNED' where id=1;update deals set status='CANCELLED' where id=1");expect(await archived()).toBeNull();expect(await access()).toEqual([]);
});
it('keeps archive documents limited to originals approved at termination, with immediate publication revocation',async()=>{
 const id=randomUUID();await db.query("insert into buyer_portal_documents(id,deal_id,owner_lead_id,title,kind,language,version,is_signed_original,storage_path,mime_type,file_size,sha256,created_by) values($1::uuid,1,1,'Original','CONTRACT','tj',1,true,'deals/1/'||$1::uuid::text||'.pdf','application/pdf',8,repeat('a',64),1)",[id]);
 await db.query("select buyer_portal_publish_document(1,$1,1,1,'PUBLISH')",[id]);await terminate();
 const materials=async()=>(await db.query('select buyer_portal_materials(101,1) value')).rows[0].value;
 expect((await materials()).documents.map(d=>d.id)).toEqual([id]);
 await db.query("select buyer_portal_publish_document(1,$1,1,1,'REVOKE')",[id]);expect((await materials()).documents).toEqual([]);
});
it('makes archived snapshots immutable and keeps tables/RPCs private',async()=>{
 await terminate();await expect(db.exec("update buyer_portal_archives set snapshot='{}'::jsonb")).rejects.toThrow('BUYER_ARCHIVE_IMMUTABLE');
 for(const role of ['anon','authenticated']){
  for(const table of ['buyer_portal_participants','buyer_portal_archives'])expect((await db.query("select has_table_privilege($1,$2,'SELECT') ok",[role,table])).rows[0].ok).toBe(false);
  for(const fn of ['buyer_portal_archive_access(bigint)','buyer_portal_archive_snapshot(bigint,integer)','buyer_portal_participant_add(integer,integer,text,text,integer)'])expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') ok",[role,fn])).rows[0].ok).toBe(false);
 }
});
it('restricts relationship approval to active leadership even at RPC boundary',async()=>{
 await db.exec("update users set role='SALES_MANAGER' where id=1");await expect(participant()).rejects.toThrow('BUYER_ACCESS_DENIED');
});
it('permanently withdraws archive access after phone, relationship or ownership revocation',async()=>{
 const id=await participant();await connect(id);await terminate();expect(await archived()).not.toBeNull();expect(await archived(202)).not.toBeNull();
 await db.exec("update leads set phone='+992900000099' where id=1;update leads set phone='+992900000001' where id=1");expect(await archived()).toBeNull();expect(await archived(202)).not.toBeNull();
 await db.query('select buyer_portal_participant_revoke(1,$1,1)',[id]);expect(await archived(202)).toBeNull();
});
it('never sends old queued facts or reminders to a terminated contract',async()=>{
 await db.exec("select buyer_portal_queue_notice(1,'PAYMENT','old-event','1','old-version')");const worker=randomUUID();
 const notice=(await db.query('select buyer_portal_claim_notice($1) value',[worker])).rows[0].value;expect(notice).not.toBeNull();
 await terminate();expect((await db.query('select buyer_portal_notice_context($1,$2) value',[notice.id,worker])).rows[0].value).toBeNull();
 expect((await db.query('select buyer_portal_reminder_candidates() value')).rows[0].value).toEqual([]);
 expect((await db.query('select buyer_portal_contact(101,1,$1,$2) value',[randomUUID(),'Question'])).rows[0].value.status).toBe('UNAVAILABLE');
});
it('executes approved participant OTP and archive reads with actual service-role privileges',async()=>{
 await db.exec('set role service_role');try{const id=await participant();await connect(id);await terminate();expect(await archived(202)).not.toBeNull();}finally{await db.exec('reset role');}
});
it('rejects an SMS challenge if participation is revoked before confirmation',async()=>{
 const id=await participant(),challenge=randomUUID(),hash='a'.repeat(64);
 await db.query("insert into buyer_portal_invites(token_hash,deal_id,lead_id,owner_lead_id,participant_id,phone_snapshot,created_by) values($1,1,2,1,$2,'+992900000002',1)",[hash,id]);
 await db.query('select buyer_portal_prepare_otp($1,202,$2,$3)',[hash,challenge,'b'.repeat(64)]);await db.query('update buyer_portal_otp set delivered_at=now() where id=$1',[challenge]);
 await db.query('select buyer_portal_participant_revoke(1,$1,1)',[id]);
 expect((await db.query('select buyer_portal_confirm_otp($1,202,$2) value',[challenge,'b'.repeat(64)])).rows[0].value.status).toBe('UNAVAILABLE');expect(await access(202)).toEqual([]);
});
it('exposes no privileged public RPC or anonymous buyer functions after all migrations',async()=>{
 const fns=(await db.query("select p.oid,p.proname,p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'buyer_portal_%'")).rows;
 expect(fns.length).toBeGreaterThan(20);
 for(const fn of fns){expect(fn.prosecdef).toBe(false);for(const role of ['anon','authenticated'])expect((await db.query("select has_function_privilege($1,$2::oid,'EXECUTE') ok",[role,fn.oid])).rows[0].ok).toBe(false);}
 const privileged=(await db.query("select proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='buyer_internal' and prosecdef")).rows;
 expect(privileged.length).toBeGreaterThan(0);for(const fn of privileged)expect(fn.proconfig.some(s=>s.startsWith('search_path=pg_catalog'))).toBe(true);
});
