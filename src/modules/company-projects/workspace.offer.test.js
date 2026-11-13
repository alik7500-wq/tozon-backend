import {beforeEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({read:vi.fn(),inventory:vi.fn()}));
vi.mock('./workspace.repository.js',()=>({readWorkspace:mocks.read,readWorkspaceInventory:mocks.inventory}));
import {calculateOffer,offerSchema,prepareOffer} from './workspace.offer.js';
const project='00000000-0000-4000-8000-000000000001',schemeId='00000000-0000-4000-8000-000000000002';
const unit={id:1,unit_number:'101',unit_kind:'APARTMENT',area_m2_x100:6000,price_per_m2_minor:70000,status:'AVAILABLE'};
const base={complex_id:3,unit_id:1,language:'RU',expected_unit_price_minor:70000,expected_area_x100:6000,expected_total_minor:4200000,scheme_id:null,scheme_updated_at:null,rule_key:null,down_payment_minor:1000000,installment_months:36,reference_rate:10};
const context={projects:[{id:project,name:'Plaza',sections:['inventory.view','documents.print']}]};
const rules=[{payment_percent:0,price_per_m2:640,months:36},{payment_percent:0,price_per_m2:700,months:40}];
beforeEach(()=>{vi.clearAllMocks();mocks.read.mockResolvedValue(context);mocks.inventory.mockResolvedValue({records:[unit],complexes:[{id:3,name:'Own complex',currency:'USD'}],schemes:[]});});
it('derives exact base, deposit and monthly preview from current unit data',()=>{
 expect(calculateOffer(unit,null,base)).toMatchObject({total_minor:4200000,down_payment_minor:1000000,remaining_minor:3200000,months:36,monthly_minor:88889});
});
it('keeps equal-deposit 36/40-month rules independent and honors the explicit price',()=>{
 const s={id:schemeId,name:'Own',updated_at:'v1',rules};
 expect(calculateOffer(unit,s,{...base,scheme_id:schemeId,scheme_updated_at:'v1',rule_key:'[0,640,0,36]',expected_total_minor:3840000})).toMatchObject({total_minor:3840000,months:36});
 expect(calculateOffer(unit,s,{...base,scheme_id:schemeId,scheme_updated_at:'v1',rule_key:'[0,700,0,40]',installment_months:40})).toMatchObject({total_minor:4200000,months:40});
});
it('rejects stale or forged totals, unit values, scheme revision and ambiguous rules',()=>{
 for(const patch of [{expected_total_minor:1},{expected_unit_price_minor:1},{expected_area_x100:1}])expect(()=>calculateOffer(unit,null,{...base,...patch})).toThrow('Условия изменились');
 const s={id:schemeId,updated_at:'new',rules:[rules[0],rules[0]]};expect(()=>calculateOffer(unit,s,{...base,scheme_id:schemeId,scheme_updated_at:'old'})).toThrow();expect(()=>calculateOffer(unit,s,{...base,scheme_id:schemeId,scheme_updated_at:'new',rule_key:'[0,640,0,36]'})).toThrow();
});
it('enforces minimum deposit and term, full payment and apartment-only constraints',()=>{
 const rule={payment_percent:30,price_per_m2:600,months:36},s={id:schemeId,updated_at:'v1',rules:[rule]};
 const input={...base,scheme_id:schemeId,scheme_updated_at:'v1',rule_key:'[30,600,0,36]',expected_total_minor:3600000};
 expect(()=>calculateOffer(unit,s,input)).toThrow('Взнос');expect(()=>calculateOffer(unit,null,{...base,installment_months:0})).toThrow('Срок');
 expect(calculateOffer(unit,null,{...base,down_payment_minor:4200000,installment_months:0}).monthly_minor).toBe(0);
 expect(()=>calculateOffer({...unit,unit_kind:'PARKING'},null,base)).toThrow('квартира');
});
it('strictly rejects actor/price overrides, unsafe money and invalid reference rates',()=>{
 expect(offerSchema.safeParse(base).success).toBe(true);
 for(const patch of [{actor:20},{final_price_minor:1},{reference_rate:0},{reference_rate:0.00000001},{down_payment_minor:0.1},{installment_months:121}])expect(offerSchema.safeParse({...base,...patch}).success).toBe(false);
});
it('checks inventory and print grants and returns only own presentation data',async()=>{
 const r=await prepareOffer(10,project,base,'Manager');expect(r).toMatchObject({project_name:'Plaza',prepared_by:'Manager',unit:{number:'101',complex_name:'Own complex'},quote:{total_minor:4200000}});expect(mocks.inventory).toHaveBeenCalledWith(10,project,3);expect(mocks.read).toHaveBeenCalledTimes(2);
 mocks.read.mockResolvedValue({projects:[{...context.projects[0],sections:['inventory.view']}]});await expect(prepareOffer(10,project,base,'Manager')).rejects.toThrow('Нет доступа');
});
it('rejects foreign units and permission revocation during preparation',async()=>{
 await expect(prepareOffer(10,project,{...base,unit_id:99},'Manager')).rejects.toThrow('не найдена');
 mocks.read.mockReset().mockResolvedValueOnce(context).mockResolvedValueOnce({projects:[]});await expect(prepareOffer(10,project,base,'Manager')).rejects.toThrow('Нет доступа');
});
