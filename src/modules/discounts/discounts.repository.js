import { getServiceDB } from '../../db/connection.js';
import { AppError } from '../../shared/errors/errorHandler.js';
import { validateScheme, validateSchemeSale } from './discounts.validation.js';
import { getBusinessDate } from '../../utils/businessTime.js';
export async function listSchemes() {
  const {data,error}=await getServiceDB().from('discount_schemes').select('*').order('name');
  if(error) throw error; return data;
}
export async function saveScheme(id,body) {
  const values=validateScheme(body), db=getServiceDB();
  let q;
  if(id) {
    if(!body.updated_at) throw new AppError('Откройте схему заново',400);
    q=db.from('discount_schemes').update({...values,updated_at:new Date().toISOString()}).eq('id',id).eq('updated_at',body.updated_at);
  } else q=db.from('discount_schemes').insert(values);
  const {data,error}=await q.select().maybeSingle();
  if(error) throw error;
  if(!data) throw new AppError('Схема изменена другим сотрудником. Обновите страницу',409);
  return data;
}
export async function deleteScheme(id) {
  const {error}=await getServiceDB().from('discount_schemes').delete().eq('id',id); if(error) throw error;
}
export async function validateDiscountForSale(data,unit) {
  if(!data.discount_scheme_id) return null;
  const {data:scheme,error}=await getServiceDB().from('discount_schemes').select('*').eq('id',data.discount_scheme_id).maybeSingle();
  if(error) throw error;
  return validateSchemeSale(scheme,data,unit,getBusinessDate());
}
