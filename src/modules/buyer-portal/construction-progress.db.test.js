import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { BuyerMaterialsService } from './materials.service.js';

let db;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table users(id integer primary key);
    create table leads(id integer primary key, phone text);
    create table projects(id integer primary key, name text);
    create table buildings(id integer primary key, project_id integer, name text);
    create table sections(id integer primary key, building_id integer, name text);
    create table floors(id integer primary key, section_id integer, floor_number integer);
    create table units(id integer primary key, floor_id integer, layout_type_id integer);
    create table deals(id integer primary key, lead_id integer, status text, unit_id integer);
    create table project_media(
      id serial primary key, project_id integer not null, category text not null,
      title text not null, description text, storage_path text not null,
      mime_type text not null default 'image/jpeg', sort_order integer not null default 0,
      is_cover boolean not null default false, is_active boolean not null default true,
      created_at text not null, updated_at text not null
    );
    insert into users values(1);
    insert into leads values(1,'+992900000001'),(2,'+992900000002');
    insert into projects values(1,'TOZON PLAZA'),(2,'TOZON OTHER');
    insert into buildings values(1,1,'Б'),(2,2,'А');
    insert into sections values(1,1,'1'),(2,2,'1');
    insert into floors values(1,1,3),(2,2,1);
    insert into units values(1,1,null),(2,2,null);
    insert into deals values(1,1,'SIGNED',1),(2,2,'SIGNED',2);
    insert into project_media(id,project_id,category,title,description,storage_path,sort_order,is_active,created_at,updated_at) values
      (1,1,'CONSTRUCTION','Монтаж кровли','Завершены работы на 12 этаже','projects/1/media/c1.jpg',1,true,'2026-11-10T10:00:00Z','2026-11-12T10:00:00Z'),
      (2,1,'CONSTRUCTION','Черновая','Скрытая запись','projects/1/media/c2.jpg',2,false,'2026-11-11T10:00:00Z','2026-11-13T10:00:00Z'),
      (3,1,'EXTERIOR','Фасад','Не строительный отчёт','projects/1/media/ext.jpg',1,true,'2026-11-11T10:00:00Z','2026-11-14T10:00:00Z'),
      (4,2,'CONSTRUCTION','Чужой ЖК','Чужое фото','projects/2/media/c3.jpg',1,true,'2026-11-12T10:00:00Z','2026-11-15T10:00:00Z');
    grant select,update on all tables in schema public to service_role;
  `);
  for (const f of [
    '20261113195039_buyer_portal_identity.sql',
    '20261113200522_buyer_portal_entry.sql',
    '20261116000000_buyer_portal_cabinet_enhancements.sql'
  ]) {
    await db.exec(readFileSync(new URL('../../../supabase/migrations/' + f, import.meta.url), 'utf8'));
  }
  await db.exec(`
    insert into buyer_portal_bindings(id,lead_id,telegram_id,phone_snapshot)
    values('11111111-1111-4111-8111-111111111111',1,101,'+992900000001');
    insert into buyer_portal_grants(binding_id,deal_id,owner_lead_id)
    values('11111111-1111-4111-8111-111111111111',1,1);
  `);
}, 20000);

afterAll(async () => { await db?.close(); });

it('returns only active CONSTRUCTION media for the buyer own project and isolates other projects', async () => {
  const row = (await db.query('select buyer_portal_construction($1,$2) value', [101, 1])).rows[0].value;
  expect(row.projectName).toBe('TOZON PLAZA');
  expect(row.items).toHaveLength(1);
  expect(row.items[0].id).toBe(1);
  expect(row.items[0].title).toBe('Монтаж кровли');
  expect(await (await db.query('select buyer_portal_construction($1,$2) value', [101, 2])).rows[0].value).toBeNull();
  expect(await (await db.query('select buyer_portal_construction($1,$2) value', [999, 1])).rows[0].value).toBeNull();
});

it('revokes public, anon and authenticated execute access on buyer_portal_construction', async () => {
  for (const role of ['anon', 'authenticated']) {
    const res = await db.query("select has_function_privilege($1,'buyer_portal_construction(bigint,integer)','EXECUTE') value", [role]);
    expect(res.rows[0].value).toBe(false);
  }
});

it('serves construction manifest without storagePath and streams authorized CONSTRUCTION photo', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const repo = {
    construction: async (tg, dealId) => (await db.query('select buyer_portal_construction($1,$2) value', [tg, dealId])).rows[0].value
  };
  const storage = { download: vi.fn(async () => jpeg) };
  const service = new BuyerMaterialsService({ repo, identity: {}, storage });

  const manifest = await service.construction('101', '1');
  expect(manifest.projectName).toBe('TOZON PLAZA');
  expect(manifest.latestTitle).toBe('Монтаж кровли');
  expect(manifest.items[0].storagePath).toBeUndefined();

  const asset = await service.asset('101', { dealId: '1', type: 'CONSTRUCTION', id: 1 });
  expect(storage.download).toHaveBeenCalledWith('project-media', 'projects/1/media/c1.jpg');
  expect(asset.mime).toBe('image/jpeg');

  await expect(service.construction('101', '2')).rejects.toMatchObject({ message: 'BUYER_MATERIAL_UNAVAILABLE', statusCode: 404 });
  await expect(service.asset('101', { dealId: '1', type: 'CONSTRUCTION', id: 4 })).rejects.toMatchObject({ message: 'BUYER_MATERIAL_UNAVAILABLE', statusCode: 404 });
});
