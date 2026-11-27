import {z} from 'zod';
import {AppError} from '../../shared/errors/errorHandler.js';
import {readWorkspace,readWorkspaceInventory} from './workspace.repository.js';

const id=z.number().int().positive().max(2147483647);
const money=z.number().int().nonnegative().max(2147483647);
export const offerSchema=z.object({
 complex_id:id,unit_id:id,language:z.enum(['RU','TJ']),
 expected_unit_price_minor:money,expected_area_x100:id,expected_total_minor:money,
 scheme_id:z.uuid().nullable(),scheme_updated_at:z.string().min(1).max(100).nullable(),rule_key:z.string().max(256).nullable(),
 down_payment_minor:money,installment_months:z.number().int().min(0).max(120),
 reference_rate:z.number().min(0.000001).max(100000).refine(n=>Math.abs(n*1e6-Math.round(n*1e6))<0.0001).nullable(),
}).strict();
const conflict=()=>{throw new AppError('Условия изменились. Закройте предложение и обновите карточку квартиры.',409);};
const ruleKey=r=>JSON.stringify([Number(r.payment_percent),r.price_per_m2==null||r.price_per_m2===''?null:Number(r.price_per_m2),Number(r.discount_percent||0),Number(r.months)]);
const mul=(a,b)=>Number((BigInt(a)*BigInt(b)+50n)/100n);

export function calculateOffer(unit,scheme,input){
 const area=Number(unit.area_m2_x100),price=Number(unit.price_per_m2_minor);
 if(unit.unit_kind!=='APARTMENT'||!Number.isSafeInteger(area)||area<=0||!Number.isSafeInteger(price)||price<=0)throw new AppError('Для предложения нужна квартира с заданной площадью и ценой',400);
 if(area!==input.expected_area_x100||price!==input.expected_unit_price_minor)conflict();
 const base=mul(area,price);let rule=null;
 if(!Number.isSafeInteger(base)||base<=0||base>2147483647)throw new AppError('Базовая стоимость выходит за пределы расчёта',400);
 if(input.scheme_id){
  if(!scheme||scheme.updated_at!==input.scheme_updated_at)conflict();
  const matches=(scheme.rules||[]).filter(r=>ruleKey(r)===input.rule_key);if(matches.length!==1)conflict();rule=matches[0];
 }else if(input.scheme_updated_at!==null||input.rule_key!==null)throw new AppError('Проверьте выбранную схему',400);
 const percent=Number(rule?.payment_percent||0),discount=Number(rule?.discount_percent||0),maxMonths=Number(rule?.months??120);
 if(!Number.isFinite(percent)||percent<0||percent>100||!Number.isFinite(discount)||discount<0||discount>100||!Number.isInteger(maxMonths)||maxMonths<0||maxMonths>120)conflict();
 const explicit=rule?.price_per_m2!=null?Math.round(Number(rule.price_per_m2)*100):null;
 if(explicit!==null&&(!Number.isSafeInteger(explicit)||explicit<=0))conflict();
 const total=explicit!==null?mul(area,explicit):base-Math.round(base*discount/100);
 if(!Number.isSafeInteger(total)||total<=0||total>base||total>2147483647||total!==input.expected_total_minor)conflict();
 const down=input.down_payment_minor,months=input.installment_months;
 if(down<Math.round(total*percent/100)||down>total)throw new AppError('Взнос не соответствует выбранному условию',400);
 const full=down===total;
 if(full?months!==0:months<1||months>maxMonths)throw new AppError('Срок не соответствует выбранному условию',400);
 return {base_minor:base,total_minor:total,discount_minor:base-total,down_payment_minor:down,remaining_minor:total-down,months,monthly_minor:months?Math.ceil((total-down)/months):0,scheme_name:scheme?.name||null,reference_rate:input.reference_rate};
}

async function authorize(actor,project){
 const context=await readWorkspace(actor,null,'projects');
 const own=context.projects.find(p=>p.id===project&&p.sections.includes('inventory.view')&&p.sections.includes('documents.print'));
 if(!own)throw new AppError('Нет доступа к предложениям этого проекта',403);return own;
}
export async function prepareOffer(actor,project,input,preparedBy){
 const own=await authorize(actor,project);
 const inventory=await readWorkspaceInventory(actor,project,input.complex_id);
 const unit=inventory.records.find(u=>u.id===input.unit_id);
 if(!unit)throw new AppError('Квартира не найдена в выбранном проекте',404);
 const complex=inventory.complexes.find(c=>c.id===input.complex_id);
 if(!complex||!['USD','TJS'].includes(complex.currency))throw new AppError('Валюта ЖК не поддерживается для предложения',400);
 const scheme=(inventory.schemes||[]).find(s=>s.id===input.scheme_id);
 const quote=calculateOffer(unit,scheme,input);
 await authorize(actor,project); // Recheck print permission after loading current data.
 return {language:input.language,checked_at:new Date().toISOString(),project_name:own.name,prepared_by:preparedBy||'',currency:complex.currency,
  unit:{number:unit.unit_number,complex_name:complex.name,building_name:unit.building_name,section_name:unit.section_name,floor:unit.floor_number,rooms:unit.rooms,area_m2_x100:unit.area_m2_x100,status:unit.status},quote};
}
