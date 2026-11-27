import {describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync,readdirSync} from 'node:fs';
import {catalogImportSQL,CATALOG_ORDER,TEST_IMPORT_REF} from './company-project-catalog-import.mjs';
const params=()=>({targetRef:TEST_IMPORT_REF,batchId:'00000000-0000-4000-8000-000000000001',snapshotAt:'2026-11-26T00:00:00Z',baseline:[],rolesB64:Buffer.from('[]').toString('base64'),tables:CATALOG_ORDER.map(table_name=>({table_name,payload_b64:Buffer.from('[]').toString('base64'),columns:['id'],rows:0,keys:[]}))});
describe('catalog-only test import',()=>{
 it('refuses production, financial tables, credentials and incomplete identity maps',()=>{
  expect(()=>catalogImportSQL({...params(),targetRef:'yeslzrrcwgcqfxhgbrqk'})).toThrow('TEST_DESTINATION_REQUIRED');
  const financial=params();financial.tables[0].table_name='payments';expect(()=>catalogImportSQL(financial)).toThrow('CATALOG_TABLE_SET_REQUIRED');
  const credentials=params();credentials.tables[0].columns.push('password_hash');expect(()=>catalogImportSQL(credentials)).toThrow('UNSAFE_PAYLOAD_METADATA');
  const missing=params();missing.tables[0].rows=1;expect(()=>catalogImportSQL(missing)).toThrow('IDENTITY_COUNT_MISMATCH');
 });
 it('keeps guards on, disabled-user checks, value/background assertions and UTC inside one transaction',()=>{
  const sql=catalogImportSQL(params());
  expect(sql).toContain("BEGIN;\nSET LOCAL TIME ZONE 'UTC'");expect(sql).toMatch(/COMMIT;\n$/);
  expect(sql).toContain('SOURCE_USERS_MUST_BE_DISABLED_AND_SCOPED');expect(sql).toContain('IMPORTED_VALUE_DRIFT');
  expect(sql).toContain('IMPORT_BACKGROUND_SIDE_EFFECT');expect(sql).toContain('BATCH_ALREADY_IMPORTED');
  expect(sql).not.toMatch(/DISABLE TRIGGER|session_replication_role|INSERT INTO public\.payments|INSERT INTO public\.expenses/i);
 });
 it('permits missing parking area while keeping apartment/commercial and positive-area checks',async()=>{
  const db=new PGlite();try{
   await db.exec("CREATE TABLE public.units(unit_kind text NOT NULL,area_m2_x100 integer NOT NULL CHECK(area_m2_x100>0))");
   const file=readdirSync('supabase/migrations').find(n=>n.endsWith('_company_project_import_parking_area.sql'));
   await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
   await db.exec("INSERT INTO public.units VALUES('PARKING',null),('APARTMENT',6000)");
   for(const value of ["('APARTMENT',null)","('COMMERCIAL',null)","('PARKING',-1)"])await expect(db.exec('INSERT INTO public.units VALUES'+value)).rejects.toThrow();
   expect((await db.query('SELECT count(*)::int n FROM units')).rows[0].n).toBe(2);
  }finally{await db.close();}
 });
});
