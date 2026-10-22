import {describe,it,expect,vi,beforeEach} from 'vitest';
vi.mock('../../../db/connection.js',()=>({getDB:vi.fn(),getServiceDB:vi.fn()}));
import {getDB,getServiceDB} from '../../../db/connection.js';
import {DealsRepository} from '../deals.repository.js';
let rpc,update;
const car={brand_model:'Test Camry',vin:'TESTVIN'};
beforeEach(()=>{
 vi.restoreAllMocks();vi.clearAllMocks();rpc=vi.fn().mockResolvedValue({error:null});update=vi.fn();
 getServiceDB.mockReturnValue({rpc});
 getDB.mockReturnValue({from:table=>{const result=table==='payments'?{count:1,error:null}:{data:{id:1,lead_id:1,payment_type:'PARTIAL_BARTER'},error:null};const q={select:()=>q,eq:()=>q,single:async()=>result,then:(resolve,reject)=>Promise.resolve(result).then(resolve,reject),update};return q;}});
 vi.spyOn(DealsRepository,'getDealById').mockResolvedValue({id:1,vehicle_details:car});
});
describe('atomic vehicle edit API path',()=>{
 it('passes validated metadata to the audited RPC and returns the canonical deal',async()=>{
  const result=await DealsRepository.updateDeal(1,{vehicle_details:car,barter_description:'Car'},1);
  expect(rpc).toHaveBeenCalledWith('update_deal_vehicle_atomic',expect.objectContaining({p_deal_id:1,p_user_id:1,p_updates_json:{vehicle_details:car,barter_description:'Car'},p_schedules_json:null}));
  expect(result.vehicle_details).toEqual(car);expect(update).not.toHaveBeenCalled();
 });
 it('fails without any fallback write if the atomic operation fails',async()=>{
  rpc.mockResolvedValue({error:{message:'Audit unavailable'}});await expect(DealsRepository.updateDeal(1,{vehicle_details:car},1)).rejects.toThrow('Audit unavailable');expect(update).not.toHaveBeenCalled();
 });
 it('rejects malformed metadata before RPC',async()=>{
  await expect(DealsRepository.updateDeal(1,{vehicle_details:{engine_number:'NO'}},1)).rejects.toThrow();expect(rpc).not.toHaveBeenCalled();expect(update).not.toHaveBeenCalled();
 });
 it('keeps paid financial updates blocked even with vehicle data',async()=>{
  await expect(DealsRepository.updateDeal(1,{vehicle_details:car,final_price_minor:1},1)).rejects.toThrow('Запрещено изменять финансовые условия');expect(rpc).not.toHaveBeenCalled();
 });
});
