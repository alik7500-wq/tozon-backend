import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync,readdirSync} from 'node:fs';
let db;
const binding='11111111-1111-4111-8111-111111111111';
beforeAll(async()=>{
 db=new PGlite();await db.exec(readFileSync(new URL('./testing/crm-fixture.sql',import.meta.url),'utf8'));
 const directory=new URL('../../../supabase/migrations/',import.meta.url);
 for(const f of readdirSync(directory).filter(f=>f.includes('_buyer_portal_')).sort())await db.exec(readFileSync(new URL(f,directory),'utf8'));
},20000);
beforeEach(async()=>{
 await db.exec(`truncate buyer_portal_archives,buyer_portal_notices,buyer_portal_inquiries,buyer_portal_audit,buyer_portal_otp,buyer_portal_invites,buyer_portal_grants,buyer_portal_bindings,buyer_portal_participants,buyer_portal_documents,tasks cascade;
 delete from deals where id>2; update deals set lead_id=id,status='SIGNED';
 update leads set phone=case when id=1 then '+992900000001' else '+992900000002' end;
 insert into buyer_portal_bindings(id,lead_id,telegram_id,phone_snapshot) values('${binding}',1,101,'+992900000001');
 insert into buyer_portal_grants(binding_id,deal_id,owner_lead_id) values('${binding}',1,1);
 insert into deals select (jsonb_populate_record(null::deals,to_jsonb(d)||'{"id":3,"contract_number":"003"}'::jsonb)).* from deals d where id=1;`);
});
afterAll(async()=>{await db?.close();});
const list=async(tg=101)=>(await db.query('select buyer_portal_contracts($1) value',[tg])).rows[0].value.map(d=>d.id).sort();
it('shows all signed contracts of one verified owner and is idempotent',async()=>{
 expect(await list()).toEqual([1,3]);expect(await list()).toEqual([1,3]);
 expect((await db.query('select count(*)::int n from buyer_portal_grants')).rows[0].n).toBe(2);
 expect(await list(202)).toEqual([]);
});
it('does not grant other leads even with the same phone',async()=>{
 await db.exec("update leads set phone='+992900000001' where id=2");expect(await list()).toEqual([1,3]);
});
it('does not resurrect revoked contracts',async()=>{
 await list();await db.exec('update buyer_portal_grants set revoked_at=now() where deal_id=3');
 expect(await list()).toEqual([1]);
});
it('does not connect unsigned or historic cancelled contracts',async()=>{
 await db.exec("update deals set status='RESERVED' where id=3");expect(await list()).toEqual([1]);
 await db.exec("update deals set status='CANCELLED' where id=3");expect(await list()).toEqual([1]);
});
it('requires a current verified owner grant and unchanged phone',async()=>{
 await db.exec("update leads set phone='+992900000009' where id=1");expect(await list()).toEqual([]);
 expect((await db.query('select count(*)::int n from buyer_portal_grants')).rows[0].n).toBe(1);
});
it('does not expand an identity without an existing owner grant',async()=>{
 await db.exec('delete from buyer_portal_grants');expect(await list()).toEqual([]);
});
it('keeps list functions inaccessible to browser database roles',async()=>{
 for(const role of ['anon','authenticated'])for(const fn of ['buyer_portal_contracts(bigint)','buyer_portal_linked_contracts(bigint)'])
 expect((await db.query('select has_function_privilege($1,$2,\'execute\') allowed',[role,fn])).rows[0].allowed).toBe(false);
});
