import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
let db;
const connection = '10000000-0000-0000-0000-000000000001';
const formSource = '20000000-0000-0000-0000-000000000001';
const igSource = '20000000-0000-0000-0000-000000000002';
const key = n => n.toString(16).padStart(64, '0');
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
    CREATE TABLE users(id bigint PRIMARY KEY,role text,is_active integer,permissions jsonb);
    CREATE TABLE projects(id bigint PRIMARY KEY,name text,archived_at text);
    CREATE TABLE leads(id bigserial PRIMARY KEY,full_name text,phone text,secondary_phone text,source text,status text,notes text,
      responsible_user_id bigint,interested_project_id bigint,created_at text,updated_at text,archived_at text);
    CREATE TABLE lead_notes(id bigserial PRIMARY KEY,lead_id bigint,author_user_id bigint,body text,created_at text);
    GRANT SELECT,INSERT,UPDATE ON users,projects,leads,lead_notes TO service_role;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;`);
  for (const path of ['20261109184102_meta_source_project_routing.sql', '20261110070826_meta_source_event_intake.sql']) {
    await db.exec(readFileSync('supabase/migrations/' + path, 'utf8'));
  }
}, 30000);
beforeEach(async () => {
  await db.exec(`TRUNCATE users,projects,leads,lead_notes,meta_source_connections,meta_source_oauth_states,meta_project_sources,meta_source_events RESTART IDENTITY CASCADE;
    INSERT INTO users VALUES(1,'ADMIN',1,'[]'),(2,'ADMIN',1,'[]');
    INSERT INTO projects VALUES(11,'Plaza',NULL),(12,'Garden',NULL),(13,'Archived','2026-01-01');
    INSERT INTO meta_source_connections(id,owner_user_id,meta_user_id,display_name,encrypted_access_token,status)
      VALUES('${connection}',1,'15','Fixture','v1.fixture','connected');
    INSERT INTO meta_project_sources(id,connection_id,channel,external_id,page_id,name,encrypted_access_token,project_id)
      VALUES('${formSource}','${connection}','FACEBOOK_FORM','41','21','Form','v1.fixture',11),
      ('${igSource}','${connection}','INSTAGRAM_MESSAGES','31','21','Instagram','v1.fixture',11);`);
});
afterAll(async () => db?.close());
const formEvent = (n = 1, formId = '41') => ({ event_key: key(n), channel: 'FACEBOOK_FORM', external_id: formId, page_id: '21',
  payload: { kind: 'FORM', form_id: formId, leadgen_id: String(100 + n) } });
async function enqueue(events) {
  return (await db.query('SELECT enqueue_meta_source_events($1::jsonb) n', [JSON.stringify(events)])).rows[0].n;
}
async function claim() { return (await db.query('SELECT claim_meta_form_events(5) r')).rows[0].r; }
async function complete(event, phone = '+992900123456') {
  return (await db.query('SELECT complete_meta_form_event($1,$2,$3::jsonb) r', [event.id, event.lease_token, JSON.stringify({ full_name: 'Fixture lead', phone, notes: 'Fixture request' })])).rows[0].r;
}
const rows = table => db.query(`SELECT * FROM ${table}`);
describe('durable Meta event intake', () => {
  it('creates a project-scoped lead once even after duplicate delivery and completion retry', async () => {
    expect(await enqueue([formEvent()])).toBe(1);
    expect(await enqueue([formEvent()])).toBe(0);
    const [event] = await claim();
    expect(await claim()).toEqual([]);
    expect(await complete(event)).toBe(true);
    expect(await complete(event)).toBe(false);
    const leads = (await rows('leads')).rows;
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ interested_project_id: 11, source: 'FACEBOOK', phone: '+992900123456', responsible_user_id: null });
    expect((await rows('meta_source_events')).rows[0].status).toBe('DONE');
  });
  it('does not merge the same phone across different projects', async () => {
    await enqueue([formEvent(1)]); await complete((await claim())[0]);
    await db.exec(`UPDATE meta_project_sources SET project_id=12 WHERE id='${formSource}'`);
    await enqueue([formEvent(2)]); await complete((await claim())[0]);
    expect((await rows('leads')).rows.map(row => Number(row.interested_project_id)).sort()).toEqual([11, 12]);
    expect((await rows('lead_notes')).rows).toHaveLength(0);
  });
  it('keeps routing captured on receipt even when the source is subsequently remapped', async () => {
    await enqueue([formEvent()]);
    await db.exec(`UPDATE meta_project_sources SET project_id=12 WHERE id='${formSource}'`);
    await complete((await claim())[0]);
    expect(Number((await rows('leads')).rows[0].interested_project_id)).toBe(11);
  });
  it('records repeats within a project without overwriting name, status or manager', async () => {
    await db.exec("INSERT INTO leads(full_name,phone,secondary_phone,status,responsible_user_id,interested_project_id) VALUES('Existing','900999999','+992 (900) 123-456','WON',7,11)");
    await enqueue([formEvent()]); await complete((await claim())[0]);
    expect((await rows('leads')).rows).toHaveLength(1);
    expect((await rows('leads')).rows[0]).toMatchObject({ full_name: 'Existing', status: 'WON', responsible_user_id: 7 });
    expect((await rows('lead_notes')).rows).toHaveLength(1);
  });
  it('holds unknown or archived contact matches for manual review without modifying them', async () => {
    await db.exec("INSERT INTO leads(full_name,phone,archived_at,interested_project_id) VALUES('Archived','900123456','2026-01-01',11)");
    await enqueue([formEvent()]); await complete((await claim())[0]);
    expect((await rows('meta_source_events')).rows[0]).toMatchObject({ status: 'NEEDS_REVIEW', error_code: 'CONTACT_REVIEW' });
    expect((await rows('leads')).rows).toHaveLength(1);
  });
  it('holds unassigned events and assigns them only after an explicit owner action', async () => {
    await db.exec(`UPDATE meta_project_sources SET project_id=NULL WHERE id='${formSource}'`);
    await enqueue([formEvent()]);
    expect(await claim()).toEqual([]);
    const event = (await rows('meta_source_events')).rows[0];
    await db.exec(`UPDATE meta_project_sources SET project_id=12 WHERE id='${formSource}'`);
    expect((await db.query('SELECT assign_meta_source_event(2,$1,12) r', [event.id])).rows[0].r).toBe(false);
    expect((await db.query('SELECT assign_meta_source_event(1,$1,11) r', [event.id])).rows[0].r).toBe(false);
    expect((await db.query('SELECT assign_meta_source_event(1,$1,12) r', [event.id])).rows[0].r).toBe(true);
    expect((await rows('meta_source_events')).rows[0]).toMatchObject({ project_id: 12, status: 'QUEUED' });
  });
  it('preserves message text in its project without inventing a phone or lead', async () => {
    await enqueue([{ event_key: key(1), channel: 'INSTAGRAM_MESSAGES', external_id: '31', page_id: null, payload: { kind: 'MESSAGE', text: 'Fixture question' } }]);
    expect((await rows('meta_source_events')).rows[0]).toMatchObject({ project_id: 11, status: 'DONE', lead_id: null });
    expect((await rows('leads')).rows).toEqual([]);
  });
  it('does not accept another Page, a revoked source or deactivated owner', async () => {
    expect(await enqueue([{ ...formEvent(), page_id: '999' }])).toBe(0);
    await db.exec('UPDATE users SET is_active=0 WHERE id=1');
    expect(await enqueue([formEvent()])).toBe(0);
    await db.exec(`UPDATE users SET is_active=1 WHERE id=1;UPDATE meta_project_sources SET available=false WHERE id='${formSource}'`);
    expect(await enqueue([formEvent()])).toBe(0);
  });
  it('rejects stale worker completion after a lease has been reclaimed', async () => {
    await enqueue([formEvent()]); const [first] = await claim();
    await db.exec("UPDATE meta_source_events SET lease_until=now()-interval '1 second'");
    const [second] = await claim();
    expect(second.lease_token).not.toBe(first.lease_token);
    expect(await complete(first)).toBe(false);
    expect(await complete(second)).toBe(true);
    expect((await rows('leads')).rows).toHaveLength(1);
  });
  it('disconnect prevents an in-flight worker from creating a lead', async () => {
    await enqueue([formEvent()]); const [event] = await claim();
    await db.exec('SELECT disconnect_meta_source_connection(1)');
    expect(await complete(event)).toBe(false);
    expect((await rows('meta_source_events')).rows[0].status).toBe('PAUSED');
    expect((await rows('leads')).rows).toEqual([]);
  });
  it('requeues paused work only explicitly and without changing the captured project', async () => {
    await enqueue([formEvent()]);
    const event = (await rows('meta_source_events')).rows[0];
    await db.exec("UPDATE meta_source_events SET status='PAUSED'");
    await db.exec(`UPDATE meta_project_sources SET project_id=12 WHERE id='${formSource}'`);
    expect((await db.query('SELECT assign_meta_source_event(1,$1,12) r', [event.id])).rows[0].r).toBe(false);
    await db.exec(`UPDATE meta_project_sources SET project_id=11 WHERE id='${formSource}'`);
    expect((await db.query('SELECT assign_meta_source_event(1,$1,11) r', [event.id])).rows[0].r).toBe(true);
    await complete((await claim())[0]);
    expect(Number((await rows('leads')).rows[0].interested_project_id)).toBe(11);
  });
  it('stores fixed retry codes with bounded retries and no free-form Meta errors', async () => {
    await enqueue([formEvent()]); const [event] = await claim();
    await db.query("SELECT fail_meta_form_event($1,$2,'META_FORM_RETRIEVAL_FAILED',false)", [event.id, event.lease_token]);
    expect((await rows('meta_source_events')).rows[0]).toMatchObject({ status: 'RETRY', error_code: 'META_FORM_RETRIEVAL_FAILED', lease_token: null });
    expect(await claim()).toEqual([]);
    await db.exec("UPDATE meta_source_events SET attempts=5,next_attempt_at=now()-interval '1 second'");
    expect(await claim()).toEqual([]);
    expect((await rows('meta_source_events')).rows[0].status).toBe('FAILED');
  });
  it('executes intake with service_role and denies all browser roles', async () => {
    await db.exec('SET ROLE service_role');
    try { await enqueue([formEvent()]); await complete((await claim())[0]); }
    finally { await db.exec('RESET ROLE'); }
    for (const role of ['anon', 'authenticated']) {
      const permissions = (await db.query(`SELECT has_table_privilege($1,'meta_source_events','SELECT') AS a,
        has_function_privilege($1,'complete_meta_form_event(uuid,uuid,jsonb)','EXECUTE') AS b`, [role])).rows[0];
      expect(permissions).toEqual({ a: false, b: false });
    }
  });
});
