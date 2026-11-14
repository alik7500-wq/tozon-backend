import {beforeAll,afterAll,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
let db;
beforeAll(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(bucket_id text,name text);alter table storage.objects enable row level security;
 grant usage on schema storage to anon,authenticated;grant select,insert on storage.objects to anon,authenticated;
 create policy future_broad_policy on storage.objects for all to anon,authenticated using(true) with check(true);
 insert into storage.objects values('buyer-documents','private.pdf'),('other','public.png');
 create table users(id integer primary key);create table leads(id integer primary key,phone text);
 create table deals(id integer primary key,lead_id integer,status text,unit_id integer);
 create table units(id integer primary key,floor_id integer,layout_type_id integer);
 create table floors(id integer primary key,section_id integer);create table sections(id integer primary key,building_id integer);create table buildings(id integer primary key,project_id integer);
 create table layout_types(id integer primary key,project_id integer,archived_at text,technical_plan_path text,furnished_plan_path text,image_path text);
 create table tours_360(id integer primary key,name text,project_id integer,is_active boolean,entity_type text,entity_id integer);
 create table panorama_360(id integer primary key,tour_id integer,name text,storage_path text,entity_type text,entity_id integer,initial_yaw numeric,initial_pitch numeric,initial_fov numeric,sort_order integer);
 create table panorama_hotspots(id integer primary key,panorama_id integer,hotspot_type text,label text,yaw numeric,pitch numeric,target_panorama_id integer);
 insert into users values(1);insert into leads values(1,'+992900000001'),(2,'+992900000002');
 insert into buildings values(1,1);insert into sections values(1,1);insert into floors values(1,1);insert into units values(1,1,1),(2,1,2);
 insert into layout_types values(1,1,null,'/layouts/own2d.png','/layouts/own3d.png',null),(2,1,null,'/layouts/foreign.png',null,null);
 insert into deals values(1,1,'SIGNED',1),(2,2,'SIGNED',2);
 insert into tours_360 values(1,'Own active',1,true,'UNIT',1),(2,'Foreign',1,true,'UNIT',2),(3,'Draft',1,false,'UNIT',1),(4,'Project fallback',1,true,'BUILDING',1);
 insert into panorama_360 values(1,1,'Own room','projects/1/own.jpg',null,null,0,0,75,1),(2,1,'Own second','projects/1/second.jpg',null,null,0,0,75,2),(3,2,'Foreign room','projects/1/foreign.jpg',null,null,0,0,75,1);
 insert into panorama_hotspots values(1,1,'NAVIGATION','Own door',0,0,2),(2,1,'NAVIGATION','Foreign door',0,0,3),(3,1,'UNIT','Secret apartment',0,0,null);
 grant select,update on all tables in schema public to service_role;`);
 for(const f of ['20261113195039_buyer_portal_identity.sql','20261113200522_buyer_portal_entry.sql','20261113221119_buyer_portal_materials.sql'])await db.exec(readFileSync(new URL('../../../supabase/migrations/'+f,import.meta.url),'utf8'));
 await db.exec(`insert into buyer_portal_bindings(id,lead_id,telegram_id,phone_snapshot) values('11111111-1111-4111-8111-111111111111',1,101,'+992900000001');
 insert into buyer_portal_grants(binding_id,deal_id,owner_lead_id) values('11111111-1111-4111-8111-111111111111',1,1);`);
},20000);
afterAll(async()=>{await db?.close();});
const manifest=async(tg=101,deal=1)=>(await db.query('select buyer_portal_materials($1,$2) value',[tg,deal])).rows[0].value;
it('restricts materials to own layout and exact active unit tour; strips foreign links and entity hotspots',async()=>{
 const r=await manifest();expect(r.plan2d).toBe('/layouts/own2d.png');expect(r.tour.id).toBe(1);
 expect(r.tour.panoramas.map(p=>p.id)).toEqual([1,2]);expect(r.tour.panoramas[0].hotspots.map(h=>h.id)).toEqual([1]);
 expect(await manifest(202,1)).toBeNull();expect(await manifest(101,2)).toBeNull();
 await db.exec('update tours_360 set is_active=false where id=1');expect((await manifest()).tour).toBeNull();await db.exec('update tours_360 set is_active=true where id=1');
});
it('keeps uploaded originals hidden until approved, audits publication and immediate revocation',async()=>{
 const row={id:'22222222-2222-4222-8222-222222222222',deal_id:1,owner_lead_id:1,title:'Signed original',kind:'CONTRACT',language:'tj',is_signed_original:true,storage_path:'deals/1/22222222-2222-4222-8222-222222222222.pdf',mime_type:'application/pdf',file_size:8,sha256:'a'.repeat(64),created_by:1};
 await db.exec('set role service_role');
 try{
  await db.query('select buyer_portal_register_document($1)',[JSON.stringify(row)]);expect((await manifest()).documents).toEqual([]);
  await db.query("select buyer_portal_publish_document(1,$1,1,1,'PUBLISH')",[row.id]);expect((await manifest()).documents[0].isSignedOriginal).toBe(true);
  await expect(db.query("update buyer_portal_documents set storage_path='deals/1/other.pdf' where id=$1",[row.id])).rejects.toThrow('BUYER_DOCUMENT_IMMUTABLE');
  await db.query("select buyer_portal_publish_document(1,$1,1,1,'REVOKE')",[row.id]);expect((await manifest()).documents).toEqual([]);
  expect((await db.query("select event from buyer_portal_audit where document_id=$1",[row.id])).rows.map(r=>r.event)).toEqual(['DOCUMENT_UPLOADED','DOCUMENT_PUBLISHED','DOCUMENT_REVOKED']);
 }finally{await db.exec('reset role');}
});
it('uses a private storage bucket and denies public table/RPC access',async()=>{
 expect((await db.query("select public from storage.buckets where id='buyer-documents'")).rows[0].public).toBe(false);
 expect((await db.query("select relrowsecurity from pg_class where oid='buyer_portal_documents'::regclass")).rows[0].relrowsecurity).toBe(true);
 for(const role of ['anon','authenticated']){
  expect((await db.query("select has_table_privilege($1,'buyer_portal_documents','SELECT') value",[role])).rows[0].value).toBe(false);
  for(const fn of ['buyer_portal_materials(bigint,integer)','buyer_portal_register_document(jsonb)','buyer_portal_publish_document(integer,uuid,integer,integer,text)'])expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') value",[role,fn])).rows[0].value).toBe(false);
 }
});
it('versions new originals and prevents publication for a different current owner',async()=>{
 const id='33333333-3333-4333-8333-333333333333';
 const row={id,deal_id:1,owner_lead_id:1,title:'Second original',kind:'CONTRACT',language:'tj',is_signed_original:true,storage_path:`deals/1/${id}.pdf`,mime_type:'application/pdf',file_size:8,sha256:'b'.repeat(64),created_by:1};
 await db.query('select buyer_portal_register_document($1)',[JSON.stringify(row)]);
 expect((await db.query('select version from buyer_portal_documents where id=$1',[id])).rows[0].version).toBe(2);
 await db.exec('update deals set lead_id=2 where id=1');
 await expect(db.query("select buyer_portal_publish_document(1,$1,2,1,'PUBLISH')",[id])).rejects.toThrow('BUYER_DOCUMENT_UNAVAILABLE');
 expect(await manifest()).toBeNull();
});
it('keeps originals private even if a broader permissive Storage policy exists',async()=>{
 for(const role of ['anon','authenticated']){
  await db.exec(`set role ${role}`);
  try{expect((await db.query('select * from storage.objects')).rows).toEqual([{bucket_id:'other',name:'public.png'}]);
   await expect(db.query("insert into storage.objects values('buyer-documents','attack.pdf')")).rejects.toThrow(/row-level security/);
  }finally{await db.exec('reset role');}
 }
});
