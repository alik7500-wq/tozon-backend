import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

let db;
const good = 'a'.repeat(64), bad = 'b'.repeat(64), qr = 'c'.repeat(64);
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table users(id integer primary key);
    create table leads(id integer primary key,phone text);
    create table deals(id integer primary key,lead_id integer references leads(id),status text);
    insert into users values(1); insert into leads values(1,'+992900000001'),(2,'+992900000002');
    insert into deals values(1,1,'SIGNED'),(2,2,'SIGNED'),(3,1,'SIGNED');`);
  await db.exec(readFileSync(new URL('../../../supabase/migrations/20261113195039_buyer_portal_identity.sql', import.meta.url), 'utf8'));
}, 20000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`truncate buyer_portal_audit,buyer_portal_otp,buyer_portal_grants,buyer_portal_bindings,buyer_portal_invites;
    update deals set lead_id=case when id=2 then 2 else 1 end,status='SIGNED';
    update leads set phone=case when id=1 then '+992900000001' else '+992900000002' end;`);
});
async function invite(hash = qr, deal = 1, lead = 1) {
  await db.query(`insert into buyer_portal_invites(token_hash,deal_id,lead_id,phone_snapshot,created_by)
    select $1,$2,$3,phone,1 from leads where id=$3`, [hash, deal, lead]);
}
async function prepare(hash = qr, tg = 101) {
  const id = randomUUID();
  const { rows } = await db.query('select buyer_portal_prepare_otp($1,$2,$3,$4) r', [hash,tg,id,good]);
  return { id, ...rows[0].r };
}
async function delivered(id) { await db.query('update buyer_portal_otp set delivered_at=now() where id=$1',[id]); }
async function confirm(id, tg = 101, hash = good) {
  return (await db.query('select buyer_portal_confirm_otp($1,$2,$3) r',[id,tg,hash])).rows[0].r.status;
}
async function access(tg = 101) { return (await db.query('select * from buyer_portal_access($1)',[tg])).rows; }

describe('buyer database authentication', () => {
  it('locks down all tables and functions to server role', async () => {
    for (const table of ['invites','bindings','grants','otp','audit']) {
      expect((await db.query(`select relrowsecurity as enabled from pg_class where oid=$1::regclass`,[`buyer_portal_${table}`])).rows[0].enabled).toBe(true);
      for (const role of ['anon','authenticated']) {
        expect((await db.query('select has_table_privilege($1,$2,\'SELECT\') p',[role,`buyer_portal_${table}`])).rows[0].p).toBe(false);
      }
    }
    for (const fn of ['buyer_portal_prepare_otp(text,bigint,uuid,text)','buyer_portal_confirm_otp(uuid,bigint,text)','buyer_portal_access(bigint)','buyer_portal_unlink(integer,integer)']) {
      for (const role of ['anon','authenticated']) expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') p",[role,fn])).rows[0].p).toBe(false);
      expect((await db.query("select has_function_privilege('service_role',$1,'EXECUTE') p",[fn])).rows[0].p).toBe(true);
    }
  });
  it('grants one explicit contract, not all contracts or other buyers', async () => {
    await invite(); const c = await prepare(); await delivered(c.id);
    expect(await access()).toEqual([]);
    expect(await confirm(c.id)).toBe('VERIFIED');
    expect((await access()).map(x=>x.deal_id)).toEqual([1]);
    expect(await access(202)).toEqual([]);
    expect(await confirm(c.id)).toBe('UNAVAILABLE');
    expect((await prepare()).status).toBe('UNAVAILABLE');
  });
  it('cannot redeem from another Telegram or before real SMS delivery', async () => {
    await invite(); const c = await prepare();
    expect(await confirm(c.id)).toBe('UNAVAILABLE');
    await delivered(c.id);
    expect(await confirm(c.id,202)).toBe('UNAVAILABLE');
    expect(await confirm(c.id)).toBe('VERIFIED');
  });
  it('persists failed attempts and locks after five, even with the right code', async () => {
    await invite(); const c = await prepare(); await delivered(c.id);
    for (let n=0;n<5;n++) expect(await confirm(c.id,101,bad)).toBe('INVALID_CODE');
    expect(await confirm(c.id)).toBe('UNAVAILABLE');
    expect(await access()).toEqual([]);
    expect((await db.query('select attempts from buyer_portal_otp')).rows[0].attempts).toBe(5);
  });
  it('expires OTP and QR and rejects revoked invitations', async () => {
    await invite(); const c = await prepare(); await delivered(c.id);
    await db.query("update buyer_portal_otp set expires_at=now()-interval '1 second' where id=$1",[c.id]);
    expect(await confirm(c.id)).toBe('UNAVAILABLE');
    await db.exec("update buyer_portal_invites set expires_at=now()-interval '2 minutes',created_at=now()-interval '16 minutes'");
    expect((await prepare()).status).toBe('UNAVAILABLE');
  });
  it('throttles new QR codes for the same buyer and Telegram', async () => {
    await invite(); expect((await prepare()).status).toBe('PREPARED');
    await invite(bad,3,1); expect((await prepare(bad,202)).status).toBe('RATE_LIMITED');
    await invite(good,2,2); expect((await prepare(good,101)).status).toBe('RATE_LIMITED');
  });
  it('allows a second explicitly verified contract for the same buyer', async () => {
    await invite(); const c = await prepare(); await delivered(c.id); await confirm(c.id);
    await db.exec("update buyer_portal_otp set created_at=now()-interval '2 minutes'");
    await invite(bad,3,1); const c2 = await prepare(bad); await delivered(c2.id);
    expect(await confirm(c2.id)).toBe('VERIFIED');
    expect((await access()).map(x=>x.deal_id).sort()).toEqual([1,3]);
  });
  it('never silently rebinds a verified buyer to a different Telegram', async () => {
    await invite(); const c = await prepare(); await delivered(c.id); await confirm(c.id);
    await db.exec("update buyer_portal_otp set created_at=now()-interval '2 minutes'");
    await invite(bad,3,1); const c2 = await prepare(bad,202); await delivered(c2.id);
    expect(await confirm(c2.id,202)).toBe('STAFF_REVIEW_REQUIRED');
    expect(await access(202)).toEqual([]);
  });
  it('permanently revokes old permissions when owner or contract state changes', async () => {
    await invite(); const c = await prepare(); await delivered(c.id); await confirm(c.id);
    await db.exec('update deals set lead_id=2 where id=1');
    expect(await access()).toEqual([]);
    await db.exec('update deals set lead_id=1 where id=1');
    expect(await access()).toEqual([]);
  });
  it('revokes bindings when the registered phone changes, including change back', async () => {
    await invite(); const c = await prepare(); await delivered(c.id); await confirm(c.id);
    await db.exec("update leads set phone='+992900000099' where id=1; update leads set phone='+992900000001' where id=1;");
    expect(await access()).toEqual([]);
  });
  it('consumes only once when duplicate redemption requests are queued', async () => {
    await invite(); const c = await prepare(); await delivered(c.id);
    expect(await Promise.all([confirm(c.id),confirm(c.id)])).toEqual(['VERIFIED','UNAVAILABLE']);
    expect((await db.query('select count(*) n from buyer_portal_grants')).rows[0].n).toBe(1);
  });
  it('unlinks all contracts and live invites with an attributable audit event',async()=>{
    await invite(); const c=await prepare(); await delivered(c.id); await confirm(c.id);
    await invite(bad,3,1);
    await db.query('select buyer_portal_unlink($1,$2)',[1,1]);
    expect(await access()).toEqual([]);
    expect((await prepare(bad)).status).toBe('UNAVAILABLE');
    const audit=await db.query("select lead_id,actor_user_id from buyer_portal_audit where event='STAFF_UNLINKED'");
    expect(audit.rows).toEqual([{lead_id:1,actor_user_id:1}]);
  });
  it('revokes access on termination, and never resurrects grants when signed again',async()=>{
    await invite(); const c=await prepare(); await delivered(c.id); await confirm(c.id);
    await db.exec("update deals set status='CANCELLED' where id=1; update deals set status='SIGNED' where id=1");
    expect(await access()).toEqual([]);
  });
  it('runs invoker RPCs with actual service-role permissions',async()=>{
    await invite();
    // PostgreSQL row locks require UPDATE permission, even though these RPCs do not edit deals.
    await db.exec('grant select on users to service_role; grant select,update on leads,deals to service_role; set role service_role');
    try {
      const c=await prepare(); expect(c.status).toBe('PREPARED'); await delivered(c.id);
      expect(await confirm(c.id)).toBe('VERIFIED'); expect(await access()).toHaveLength(1);
    } finally { await db.exec('reset role'); }
  });
});
