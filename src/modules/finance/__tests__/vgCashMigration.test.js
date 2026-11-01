import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const vg='9dc0e06d-5e0b-4bad-8bb7-83161d7a70a2';const ab='00000000-0000-0000-0000-000000000001';
it('migration is idempotent and rejects mixed cash documents and transfers',async()=>{
 const db=new PGlite();try{
 await db.exec(`create table dictionaries(id uuid primary key,type text,name text,code text,color text,icon text,sort_order int,is_active bool,is_system bool);create table buildings(id int,project_id int);create table sections(id int,building_id int);create table floors(id int,section_id int);create table units(id int,floor_id int);create table deals(id int,unit_id int);create table payments(id int,deal_id int,cash_desk_id uuid);create table expenses(id int,deal_id int,cash_desk_id uuid);create table cash_transfers(source_cash_desk_id uuid,destination_cash_desk_id uuid);insert into buildings values(3,3),(4,4);insert into sections values(3,3),(4,4);insert into floors values(3,3),(4,4);insert into units values(3,3),(4,4);insert into deals values(3,3),(4,4);`);
 const sql=readFileSync('supabase/migrations/20261101100835_isolate_vg_cash_accounting.sql','utf8');await db.exec(sql);await db.exec(sql);
 for(const table of ['payments','expenses']){
  await expect(db.exec(`insert into ${table} values(1,4,'${ab}')`)).rejects.toThrow('выберите кассу');
  await expect(db.exec(`insert into ${table} values(2,3,'${vg}')`)).rejects.toThrow('других объектов');
  await db.exec(`insert into ${table} values(3,4,'${vg}'),(4,3,'${ab}'),(5,null,'${vg}')`);
  await expect(db.exec(`update ${table} set cash_desk_id='${ab}' where id=3`)).rejects.toThrow('нельзя переносить');
 }
 await expect(db.exec(`insert into cash_transfers values('${vg}','${ab}')`)).rejects.toThrow('раздельный учёт');
 await expect(db.exec(`insert into cash_transfers values('${ab}','${vg}')`)).rejects.toThrow('раздельный учёт');
 await expect(db.exec('update deals set unit_id=3 where id=4')).rejects.toThrow('нельзя переносить');
 expect((await db.query('select count(*)::int n from dictionaries')).rows[0].n).toBe(1);
 }finally{await db.close()}
},30000);
