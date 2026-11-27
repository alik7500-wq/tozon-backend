import {beforeAll,afterAll,beforeEach,afterEach,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createWorkspaceFixture,cashA,cashB} from './workspace.fixture.js';
let db,plaza,tower;
const material='00000000-0000-4000-8000-000000000101';
const stock=(actor=10,project=plaza,warehouse=null)=>db.query('select read_company_project_stock($1,$2,$3) as result',[actor,project,warehouse]).then(r=>r.rows[0].result);
async function denied(call,message){await db.exec('SAVEPOINT denial');try{await expect(call()).rejects.toThrow(message);}finally{await db.exec('ROLLBACK TO denial;RELEASE denial');}}
async function entry({warehouse=cashA,source=warehouse,destination=null,complex=null,kind='RECEIPT',status='POSTED',currency='TJS',entryCurrency=currency,quantity='10',value='100'}={}){
 const doc=(await db.query('insert into construction_documents(id,warehouse_id,destination_id,project_id,kind,status,currency) values(gen_random_uuid(),$1,$2,$3,$4,$5,$6) returning id',[source,destination,complex,kind,status,currency])).rows[0].id;
 await db.query('insert into construction_stock_entries(document_id,warehouse_id,material_id,currency,quantity,value) values($1,$2,$3,$4,$5,$6)',[doc,warehouse,material,entryCurrency,quantity,value]);return doc;
}
beforeAll(async()=>{
 ({db,plaza,tower}=await createWorkspaceFixture());
 await db.exec(`CREATE TABLE construction_materials(id uuid PRIMARY KEY,name text,unit text,active boolean DEFAULT true);
 CREATE TABLE construction_documents(id uuid PRIMARY KEY,warehouse_id uuid,destination_id uuid,project_id integer,kind text,status text,currency text);
 CREATE TABLE construction_stock_entries(id bigint GENERATED ALWAYS AS IDENTITY,document_id uuid,warehouse_id uuid,material_id uuid,currency text,quantity numeric(18,4),value numeric(18,2));
 INSERT INTO construction_materials VALUES('${material}','Арматура','кг',false);
 GRANT SELECT ON construction_materials,construction_documents,construction_stock_entries TO service_role;`);
 await db.exec(readFileSync(new URL('../../../supabase/migrations/20261116093608_company_project_stock_balances.sql',import.meta.url),'utf8'));
},30000);
afterAll(()=>db?.close());beforeEach(()=>db.exec('BEGIN'));afterEach(()=>db.exec('ROLLBACK'));
it('reads only its own warehouse ledger and sums signed entries by currency',async()=>{
 await entry({quantity:'10',value:'100'});await entry({kind:'ISSUE',quantity:'-3.5',value:'-25.5'});await entry({currency:'USD',quantity:'2',value:'30'});await entry({warehouse:cashB,value:'999'});
 const r=await stock();expect(r.selected_warehouse_id).toBe(cashA);expect(r.warehouses).toHaveLength(1);expect(r.records).toEqual([
  {material_id:material,name:'Арматура',unit:'кг',currency:'TJS',quantity:'6.5000',value:'74.50'},
  {material_id:material,name:'Арматура',unit:'кг',currency:'USD',quantity:'2.0000',value:'30.00'}]);
 expect(r.totals).toEqual([{currency:'TJS',value:'74.50'},{currency:'USD',value:'30.00'}]);expect(JSON.stringify(r)).not.toContain(cashB);
});
it('does not give a foreign project or unrestricted administrator access',async()=>{
 await denied(()=>stock(10,tower),'WORKSPACE_ACCESS_DENIED');await denied(()=>stock(30),'WORKSPACE_ACCESS_DENIED');await denied(()=>stock(10,plaza,cashB),'WORKSPACE_RECORD_NOT_FOUND');
});
it('rechecks permission and active identity for each request',async()=>{
 await stock();await db.exec("UPDATE company_workspace_access SET sections=ARRAY['inventory.view'] WHERE user_id=10");await expect(stock()).rejects.toThrow('WORKSPACE_ACCESS_DENIED');
});
it('keeps inactive assigned warehouses and archived material balances visible as history',async()=>{
 await db.exec('UPDATE construction_warehouses SET active=false');await entry();const r=await stock();expect(r.warehouses[0].active).toBe(false);expect(r.records[0].name).toBe('Арматура');
});
it('returns empty stock without inventing opening balances',async()=>{
 expect(await stock()).toMatchObject({records:[],totals:[]});await db.exec('DELETE FROM company_project_warehouses');expect(await stock()).toMatchObject({warehouses:[],selected_warehouse_id:null,records:[],totals:[]});
});
it('preserves decimal precision and omits only fully zero balances',async()=>{
 await entry({value:'9999999999999999.99'});expect((await stock()).records[0].value).toBe('9999999999999999.99');
 await db.exec('DELETE FROM construction_stock_entries');await entry({quantity:'1',value:'10'});await entry({kind:'ISSUE',quantity:'-1',value:'-10'});expect((await stock()).records).toEqual([]);
});
it('allows intra-project transfer entries without exposing the other project',async()=>{
 const second='00000000-0000-4000-8000-000000000003';await db.query('INSERT INTO construction_warehouses VALUES($1,$2,true)',[second,'Own second']);await db.query('INSERT INTO company_project_warehouses VALUES($1,$2)',[second,plaza]);
 await entry({kind:'TRANSFER',warehouse:second,source:cashA,destination:second});expect((await stock(10,plaza,second)).records).toHaveLength(1);
});
it('refuses contradictory cross-project warehouse or complex history rather than returning a partial total',async()=>{
 for(const options of [{source:cashB},{complex:2},{kind:'TRANSFER',destination:cashB},{source:cashB,kind:'TRANSFER',destination:cashA},{status:'DRAFT'},{entryCurrency:'USD'}]){
  await db.exec('DELETE FROM construction_stock_entries');await entry(options);await denied(()=>stock(),'WORKSPACE_STOCK_SCOPE_CONFLICT');
 }
});
it('does not silently truncate reports larger than 5000 balances',async()=>{
 const doc=await entry();await db.query(`WITH mats AS (INSERT INTO construction_materials SELECT gen_random_uuid(),'Extra','кг',true FROM generate_series(1,5000) RETURNING id) INSERT INTO construction_stock_entries(document_id,warehouse_id,material_id,currency,quantity,value) SELECT $1,$2,id,'TJS',1,1 FROM mats`,[doc,cashA]);
 await expect(stock()).rejects.toThrow('WORKSPACE_STOCK_TOO_LARGE');
});
it('is server-only and does not change existing data',async()=>{
 await entry();const before=await db.query('select * from construction_stock_entries');await db.exec('SET ROLE service_role');await stock();await db.exec('RESET ROLE');expect(await db.query('select * from construction_stock_entries')).toEqual(before);
 await db.exec('SET ROLE authenticated');await expect(stock()).rejects.toThrow();
});
