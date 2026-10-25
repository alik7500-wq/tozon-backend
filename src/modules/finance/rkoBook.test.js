import {describe,it,expect,vi} from 'vitest';
import ExcelJS from 'exceljs';
import {getRkoBook,isRko,rkoBookWorkbook,validateRkoFilters} from './rkoBook.js';
function database(rows) {
 const reads=[];
 return {reads,from(table){
  let selected=[...rows];const q={select(){return q;},order(){return q;},
   eq(key,value){if(table==='expenses'){reads.push(['eq',key,value]);selected=selected.filter(e=>e[key]===value);}return q;},
   in(key,values){reads.push(['in',key,values]);selected=selected.filter(e=>values.includes(e[key]));return q;},
   gte(key,value){selected=selected.filter(e=>e[key]>=value);return q;},lte(key,value){selected=selected.filter(e=>e[key]<=value);return q;},
   async range(start,end){reads.push(['range',start,end]);return {data:selected.slice(start,end+1)};},
   then(resolve,reject){return Promise.resolve({data:table==='dictionaries'?[{id:'a',name:'Касса А'},{id:'b',name:'Касса Б'}]:selected}).then(resolve,reject);}};return q;
 }};
}
const entry=(overrides={})=>({id:1,amount_minor:12345,currency:'TJS',expense_date:'2026-10-25',reference:'РКО-1',category:'Материалы',recipient:'Поставщик',description:'Накладная',cash_desk_id:'a',status:'ACTIVE',users:{name:'Кассир'},...overrides});
const admin={isAdmin:true};
describe('RKO registration book',()=>{
 it('keeps genuine RKO including paired payments/transfers, excluding only conversion records',()=>{
  expect(isRko(entry({conversion_id:'pair',operation_type:'STANDARD'}))).toBe(true);
  expect(isRko(entry({transfer_id:'pair',operation_type:'INTERNAL_TRANSFER'}))).toBe(true);
  expect(isRko(entry({operation_type:'CONVERSION'}))).toBe(false);expect(isRko(entry({reference:'КОНВ-2'}))).toBe(false);
 });
 it('retains voided records, original numbers, native amounts and cash desk names; totals active records only',async()=>{
  const result=await getRkoBook(database([entry(),entry({id:2,amount_minor:99999,status:'VOIDED'}),entry({id:3,operation_type:'CONVERSION'})]),{},admin);
  expect(result.list).toHaveLength(2);expect(result.totalsByCurrency).toEqual({TJS:123.45});expect(result.list[0]).toMatchObject({reference:'РКО-1',amount:123.45,cashDeskName:'Касса А',createdByName:'Кассир'});
 });
 it('filters currency, dates, status and search consistently',async()=>{
  const db=database([entry(),entry({id:2,expense_date:'2026-10-24',currency:'USD'}),entry({id:3,status:'VOIDED'})]);
  const result=await getRkoBook(db,{date_from:'2026-10-25',date_to:'2026-10-25',currency:'TJS',book_status:'VOIDED',search:'поставщик'},admin);
  expect(result.list.map(e=>e.id)).toEqual([3]);expect(result.totalsByCurrency).toEqual({});
 });
 it('enforces cash-desk scope in SQL and rejects foreign-desk filters and missing access',async()=>{
  const db=database([entry(),entry({id:2,cash_desk_id:'b'})]);const access={isAdmin:false,viewableDeskIds:['a'],canView:true};
  expect((await getRkoBook(db,{},access)).list.map(e=>e.id)).toEqual([1]);expect(db.reads).toContainEqual(['in','cash_desk_id',['a']]);
  await expect(getRkoBook(db,{cash_desk_id:'b'},access)).rejects.toThrow('Нет доступа');
  await expect(getRkoBook(db,{})).rejects.toThrow('Нет доступа');
  expect((await getRkoBook(db,{}, {isAdmin:false,viewableDeskIds:[]})).list).toEqual([]);
 });
 it('loads more than one server page without truncating the book',async()=>{
  const db=database(Array.from({length:501},(_,id)=>entry({id})));
  const result=await getRkoBook(db,{},admin);expect(result.list).toHaveLength(501);expect(db.reads).toContainEqual(['range',500,999]);
 });
 it.each([{date_from:'2026-02-30'},{date_from:'2026-10-25',date_to:'2026-10-24'},{book_status:'bad'}])('rejects invalid filters %j',f=>expect(()=>validateRkoFilters(f)).toThrow());
 it('exports real Excel numbers, native currencies, voided status and active-only formulas',async()=>{
  const data=await getRkoBook(database([entry({recipient:'=HYPERLINK("bad")'}),entry({id:2,amount_minor:20000,currency:'USD',status:'VOIDED'})]),{},admin);
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(await rkoBookWorkbook(data.list));const ws=wb.worksheets[0];
  expect(ws.getCell('B9').value).toBe('РКО-1');expect(ws.getCell('C9').value).toBe("'=HYPERLINK(\"bad\")");expect(ws.getCell('G9').value).toBe(123.45);expect(ws.getCell('K10').value).toBe('Аннулирован');
  expect(ws.getCell('G13').value).toMatchObject({result:123.45});expect(ws.getCell('G14').value.result||0).toBe(0);expect(ws.getCell('G14').value.formula).toContain('SUMIFS');expect(ws.views[0]).toMatchObject({xSplit:2,ySplit:8});expect(ws.pageSetup.orientation).toBe('landscape');
 });
 it('exports an empty book without invalid formulas',async()=>{
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(await rkoBookWorkbook([]));expect(wb.worksheets[0].autoFilter).toBe('A8:K8');
 });
});
