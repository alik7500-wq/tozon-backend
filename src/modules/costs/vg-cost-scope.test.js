import {it,expect} from 'vitest';
import {buildCostReport} from './costs.service.js';
import {VG_CASH_DESK_ID} from '../finance/accountingScope.js';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
it('separates cost totals and unassigned rows; mixed legacy allocations never enter the other project',()=>{
 const input={buildings:[{id:3,project_id:3},{id:6,project_id:4}],bases:[],registry:{},advances:[],asOf:'2026-11-01',expenses:[{id:1,cash_desk_id:'AB',amount_minor:10000,currency:'USD',expense_date:'2026-11-01'},{id:2,cash_desk_id:VG_CASH_DESK_ID,amount_minor:50000,currency:'USD',expense_date:'2026-11-01'}],allocations:[{expense_id:1,mode:'DIRECT',shares:[{building_id:3,weight:1}]},{expense_id:2,mode:'DIRECT',shares:[{building_id:6,weight:1}]}]};
 const ab=buildCostReport(input),vg=buildCostReport({...input,accountingScope:'VG'});
 expect(ab.blocks.map(b=>b.id)).toEqual([3]);expect(ab.rows.map(r=>r.id)).toEqual([1]);expect(ab.totals.allocated_usd_minor).toBe(10000);
 expect(vg.blocks.map(b=>b.id)).toEqual([6]);expect(vg.rows.map(r=>r.id)).toEqual([2]);expect(vg.totals.allocated_usd_minor).toBe(50000);
 expect(buildCostReport({...input,allocations:[{expense_id:1,mode:'DIRECT',shares:[{building_id:6,weight:1}]}]}).totals.allocated_usd_minor).toBe(0);
});
it('rejects cross-project allocations and material payment links in PostgreSQL',async()=>{
 const db=new PGlite();try{
 await db.exec(`create table buildings(id int,project_id int);create table expenses(id int,cash_desk_id uuid);create table cost_expense_allocations(expense_id int,mode text,shares jsonb);create table cost_material_usages(id uuid,building_id int,stock_entry_id bigint);create table cost_material_payment_links(expense_id int,usage_id uuid,status text);create table construction_documents(id int,project_id int);create table construction_stock_entries(id bigint,document_id int);
 insert into buildings values(3,3),(6,4);insert into expenses values(1,null),(2,'${VG_CASH_DESK_ID}');`);
 const sql=readFileSync('supabase/migrations/20261101102310_isolate_vg_cost_allocations.sql','utf8');await db.exec(sql);await db.exec(sql);
 const assign=(expense,building)=>db.exec(`insert into cost_expense_allocations values(${expense},'DIRECT','[{"building_id":${building},"weight":1}]')`);
 await assign(1,3);await assign(2,6);await expect(assign(1,6)).rejects.toThrow('только внутри');await expect(assign(2,3)).rejects.toThrow('только внутри');
 await db.exec(`insert into cost_material_usages values('00000000-0000-0000-0000-000000000003',3,null),('00000000-0000-0000-0000-000000000006',6,null);`);
 await expect(db.exec(`insert into cost_material_payment_links values(2,'00000000-0000-0000-0000-000000000003','ACTIVE')`)).rejects.toThrow('другим объектом');
 await db.exec(`insert into cost_material_payment_links values(2,'00000000-0000-0000-0000-000000000006','ACTIVE')`);
 await expect(db.exec(`update cost_material_usages set building_id=3 where building_id=6`)).rejects.toThrow('между блоками');
 }finally{await db.close()}
},30000);
