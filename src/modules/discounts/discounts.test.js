import {describe,it,expect} from 'vitest';
import {validateScheme,validateSchemeSale} from './discounts.validation.js';
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
