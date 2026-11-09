import {describe,it,expect} from 'vitest';
import {validateScheme,validateSchemeSale,discountRuleKey} from './discounts.validation.js';
const rules=[{payment_percent:0,discount_percent:0,months:30},{payment_percent:5,discount_percent:2.86,months:30},{payment_percent:15,discount_percent:7.14,months:30},{payment_percent:30,discount_percent:11.43,months:30},{payment_percent:50,discount_percent:17.14,months:30},{payment_percent:100,discount_percent:21.43,months:0}];
const scheme={id:'test',project_id:3,name:'Плаза',updated_at:'version',is_active:true,rules};
const unit={unit_kind:'APARTMENT',area_m2_x100:4322,price_per_m2_minor:70000,floors:{sections:{buildings:{projects:{id:3}}}}};
const sale=r=>{const base=3025400,discount=Math.round(base*r.discount_percent/100),final=base-discount;return {discount_scheme_updated_at:'version',discount_rule_payment_percent:r.payment_percent,base_price_minor:base,discount_minor:discount,final_price_minor:final,down_payment_minor:Math.round(final*r.payment_percent/100),installment_months:r.months,payment_type:r.payment_percent===100?'FULL':'INSTALLMENT'}};
describe('discount schemes',()=>{
 it.each(rules)('calculates and snapshots the $payment_percent percent condition',r=>{expect(validateSchemeSale(scheme,sale(r),unit,'2026-10-28')).toMatchObject({...r,scheme_name:'Плаза'});});
 it.each(['final_price_minor','discount_minor','down_payment_minor','installment_months'])('rejects manipulated %s',key=>{expect(()=>validateSchemeSale(scheme,{...sale(rules[1]),[key]:999},unit,'2026-10-28')).toThrow();});
 it('rejects stale version, other project, expired or disabled scheme',()=>{for(const altered of [{updated_at:'new'},{project_id:4},{ends_on:'2026-10-27'},{is_active:false}])expect(()=>validateSchemeSale({...scheme,...altered},sale(rules[1]),unit,'2026-10-28')).toThrow();});
 it('validates dates, duplicates and full-payment term',()=>{for(const patch of [{starts_on:'2026-99-99'},{rules:[rules[1],rules[1]]},{rules:[{...rules[5],months:30}]}])expect(()=>validateScheme({name:'test',project_id:3,rules,...patch})).toThrow();expect(validateScheme({name:'test',project_id:3,rules})).toMatchObject({rules});});
});
it('uses explicit price per square metre without stacking percentage',()=>{
 const rule={...rules[1],price_per_m2:650};
 const final=2809300;
 const input={...sale(rule),final_price_minor:final,discount_minor:3025400-final,down_payment_minor:Math.round(final*0.05)};
 expect(validateSchemeSale({...scheme,rules:[rule]},input,unit,'2026-10-28')).toMatchObject({price_per_m2:650,final_price_minor:final});
 expect(validateScheme({name:'test',project_id:3,rules:[rule]}).rules[0].price_per_m2).toBe(650);
 for(const price of [-1,0,650.001,'invalid']) expect(()=>validateScheme({name:'test',project_id:3,rules:[{...rule,price_per_m2:price}]})).toThrow();
 expect(()=>validateSchemeSale({...scheme,rules:[{...rule,price_per_m2:750}]},input,unit,'2026-10-28')).toThrow();
});
it('allows the actual client deposit above the tier minimum and a shorter term',()=>{
 const data={...sale(rules[3]),down_payment_minor:1500000,installment_months:24};
 expect(validateSchemeSale(scheme,data,unit,'2026-10-28')).toMatchObject({payment_percent:30,agreed_down_payment_minor:1500000,agreed_installment_months:24});
 for(const patch of [{down_payment_minor:1},{down_payment_minor:data.final_price_minor+1},{down_payment_minor:100.5},{installment_months:31},{installment_months:0}])expect(()=>validateSchemeSale(scheme,{...data,...patch},unit,'2026-10-28')).toThrow();
});
it('permits paying a selected tier in full only with FULL type and zero installments',()=>{
 const data=sale(rules[3]);data.down_payment_minor=data.final_price_minor;data.payment_type='FULL';data.installment_months=0;
 expect(validateSchemeSale(scheme,data,unit,'2026-10-28')).toMatchObject({agreed_installment_months:0});
 expect(()=>validateSchemeSale(scheme,{...data,payment_type:'INSTALLMENT'},unit,'2026-10-28')).toThrow();
});

const zeroOffers=[{payment_percent:0,discount_percent:0,price_per_m2:700,months:40},{payment_percent:0,discount_percent:8.57,price_per_m2:640,months:36}];
it('saves distinct offers with the same deposit, including equal prices with different terms',()=>{
 const rules=[...zeroOffers,{...zeroOffers[1],months:24}];
 expect(validateScheme({name:'Офферы',project_id:3,rules}).rules).toEqual(rules);
 expect(()=>validateScheme({name:'Офферы',project_id:3,rules:[zeroOffers[0],zeroOffers[0]]})).toThrow('одинаковые');
});
it.each(zeroOffers)('validates and snapshots the exact zero deposit offer at $price_per_m2 for $months months',rule=>{
 const final=Math.round(unit.area_m2_x100*rule.price_per_m2);
 const data={...sale(rule),discount_rule_key:discountRuleKey(rule),final_price_minor:final,discount_minor:3025400-final};
 const current={...scheme,rules:zeroOffers};
 expect(validateSchemeSale(current,data,unit,'2026-11-09')).toMatchObject({...rule,rule_key:discountRuleKey(rule),final_price_minor:final});
 expect(validateSchemeSale({...current,rules:[...zeroOffers].reverse()},data,unit,'2026-11-09').price_per_m2).toBe(rule.price_per_m2);
 expect(()=>validateSchemeSale(current,{...data,discount_rule_key:undefined},unit,'2026-11-09')).toThrow('несколько офферов');
 expect(()=>validateSchemeSale(current,{...data,discount_rule_key:discountRuleKey(zeroOffers.find(r=>r!==rule))},unit,'2026-11-09')).toThrow('Цена');
 expect(()=>validateSchemeSale(current,{...data,discount_rule_key:'invalid'},unit,'2026-11-09')).toThrow('не найдено');
});
