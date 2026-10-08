import { getServiceDB } from '../../db/connection.js';

// No cache: changes to booking and discount rules take effect on the next operation.
export async function getDealRules() {
  const {data,error}=await getServiceDB().from('crm_document_settings').select('data').eq('id',1).single();
  if(error) throw error;
  return {reservation_days:data.data.reservation_days ?? 3,max_discount_percent:data.data.max_discount_percent ?? 100};
}
