import {describe,it,expect,vi,beforeEach} from 'vitest';
vi.mock('../../../db/connection.js',()=>({getServiceDB:vi.fn(),getDB:()=>{throw Error('Public client cannot read protected presentation tables');}}));
import {getServiceDB} from '../../../db/connection.js';
import {LayoutPresentationRepository as Repo} from '../layout_presentation.repository.js';
let update,from,fail;
beforeEach(()=>{fail=false;update=vi.fn();from=vi.fn(table=>{const data=table==='units'?{id:1,layout_types:{id:7},floors:{sections:{buildings:{project_id:3}}}}:table==='layout_types'?{id:7,project_id:3}:table==='layout_rooms'?[{id:1,description_ru:'Гостиная'}]:table==='layout_features'?[{id:1,text_ru:'Потолки 3,15 м'}]:[];const q={select:()=>q,eq:()=>q,order:()=>q,maybeSingle:async()=>({data}),update:x=>{update(x);return q;},single:async()=>({data:{id:7}}),then:resolve=>resolve({data,error:fail&&table==='layout_rooms'?Error('failed'):null})};return q;});getServiceDB.mockReturnValue({from});});
describe('protected apartment presentation access',()=>{
it('reads rooms and features through the server client',async()=>{const r=await Repo.getUnitPresentationData(1,{role:'FINANCE_MANAGER',assigned_project_ids:[3]});expect(r.rooms).toHaveLength(1);expect(r.features).toHaveLength(1);});
it('still enforces assigned project scope',async()=>{await expect(Repo.getUnitPresentationData(1,{role:'SALES_MANAGER',assigned_project_ids:[2]})).rejects.toThrow('Доступ');expect(from.mock.calls.some(([x])=>x==='layout_rooms')).toBe(false);});
it('reports failed room reads instead of showing an empty list',async()=>{fail=true;await expect(Repo.getUnitPresentationData(1,{role:'ADMIN'})).rejects.toThrow('Не удалось');});
it('saves gallery entries and rejects unsafe image protocols',async()=>{await Repo.updateLayoutExtended(7,{gallery_images:[{url:'https://example.com/room.jpg',title:'Спальня'}]},{role:'ADMIN'});expect(update.mock.calls[0][0].gallery_images).toHaveLength(1);await expect(Repo.updateLayoutExtended(7,{gallery_images:[{url:'javascript:alert(1)'}]},{role:'ADMIN'})).rejects.toThrow('ссылки');});
});
