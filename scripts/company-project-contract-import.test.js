import {describe,it,expect,beforeEach,afterEach} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync,readdirSync} from 'node:fs';
let db;
const batch='00000000-0000-4000-8000-000000000001';
beforeEach(async()=>{
 db=new PGlite();
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE SCHEMA tozon_internal;CREATE SCHEMA tozon_import;
 CREATE TABLE tozon_import.batches(id uuid PRIMARY KEY,source_ref text);
 INSERT INTO tozon_import.batches VALUES('${batch}','yeslzrrcwgcqfxhgbrqk');
 CREATE TABLE public.users(id integer PRIMARY KEY);CREATE TABLE public.marketing_partners(id bigint PRIMARY KEY);
 CREATE TABLE public.projects(id integer,code text);CREATE TABLE public.buildings(id integer,project_id integer,name text);
 CREATE TABLE public.sections(id integer,building_id integer);CREATE TABLE public.floors(id integer,section_id integer);
 CREATE TABLE public.units(id integer,floor_id integer,unit_number text);
 CREATE TABLE public.crm_document_settings(id integer,data jsonb);INSERT INTO public.crm_document_settings VALUES(1,'{"numbering":{"CONTRACT":"{id4}"}}');
 CREATE TABLE public.deals(id integer PRIMARY KEY,contract_number text UNIQUE,unit_id integer,lead_id integer,deal_date text,status text,company_project_id uuid,company_director_snapshot jsonb,company_closure_snapshot jsonb,marketing_partner_id bigint,source_confirmed_by integer,final_price_minor bigint);
 INSERT INTO public.deals(id,contract_number) VALUES(1,'0001');
 CREATE TABLE public.sms_probe(event text);
 CREATE FUNCTION tozon_internal.queue_configured_sms(text,text,integer,integer,integer DEFAULT NULL) RETURNS void LANGUAGE sql AS 'INSERT INTO public.sms_probe VALUES($1)';
 `);
 const migration=readdirSync('supabase/migrations').find(n=>n.endsWith('_company_project_legacy_contract_import.sql'));
 await db.exec(readFileSync('supabase/migrations/'+migration,'utf8'));
 await db.exec(`CREATE TRIGGER crm_deal_number BEFORE INSERT ON public.deals FOR EACH ROW EXECUTE FUNCTION tozon_internal.assign_document_number();CREATE TRIGGER queue_deal_sms AFTER INSERT OR UPDATE ON public.deals FOR EACH ROW EXECUTE FUNCTION tozon_internal.queue_deal_sms();`);
});
afterEach(async()=>{await db.close();});
const insert=id=>db.query('INSERT INTO deals(id,contract_number,status,source_import_batch_id) VALUES($1,\'0001\',\'SIGNED\',$2)',[id,batch]);
describe('owner-only legacy contract import',()=>{
 it('preserves a source number alongside demo history without generating SMS',async()=>{
  await db.query("SELECT set_config('tozon.import_batch',$1,false)",[batch]);
  await insert(1000001);
  expect((await db.query("SELECT count(*)::int n FROM deals WHERE contract_number='0001'")).rows[0].n).toBe(2);
  expect((await db.query('SELECT count(*)::int n FROM sms_probe')).rows[0].n).toBe(0);
  await expect(insert(1000002)).rejects.toThrow();
  await expect(db.exec('UPDATE deals SET source_import_batch_id=NULL WHERE id=1000001')).rejects.toThrow('IMPORT_SOURCE_IMMUTABLE');
 });
 it('rejects missing owner context and a forged service-role import even with the setting',async()=>{
  await expect(insert(1000001)).rejects.toThrow('OWNER_IMPORT_TRANSACTION_REQUIRED');
  await db.exec('GRANT USAGE ON SCHEMA public TO service_role;GRANT INSERT,SELECT ON public.deals TO service_role;SET ROLE service_role');
  await db.query("SELECT set_config('tozon.import_batch',$1,false)",[batch]);
  await expect(insert(1000001)).rejects.toThrow('OWNER_IMPORT_TRANSACTION_REQUIRED');
 });
 it('keeps native numbering and refuses invented historical signer data',async()=>{
  await db.exec("INSERT INTO deals(id,status,deal_date) VALUES(2,'DRAFT','2026-11-27')");
  expect((await db.query('SELECT contract_number FROM deals WHERE id=2')).rows[0].contract_number).toBe('0002');
  await db.query("SELECT set_config('tozon.import_batch',$1,false)",[batch]);
  await expect(db.query("INSERT INTO deals(id,contract_number,source_import_batch_id,company_director_snapshot) VALUES(3,'test',$1,'{}')",[batch])).rejects.toThrow('LEGACY_SCOPE_SNAPSHOT_MUST_NOT_BE_INVENTED');
 });
});
