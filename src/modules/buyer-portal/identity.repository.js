import { getServiceDB } from '../../db/connection.js';
const data = result => { if (result.error) throw new Error('BUYER_DATABASE_UNAVAILABLE'); return result.data; };
export class BuyerIdentityRepository {
  constructor(db) { this.database=db; }
  get db() { return this.database || getServiceDB(); }
  async deal(id) {
    return data(await this.db.from('deals').select('id,lead_id,status,responsible_user_id,leads(phone)').eq('id',id).maybeSingle());
  }
  async createInvite(row) {
    return data(await this.db.from('buyer_portal_invites').insert(row).select('id,expires_at').single());
  }
  async prepare({tokenHash,telegramId,id,codeHash}) {
    return data(await this.db.rpc('buyer_portal_prepare_otp',{p_token_hash:tokenHash,p_telegram_id:telegramId,p_id:id,p_code_hash:codeHash}));
  }
  async delivered(id) {
    data(await this.db.from('buyer_portal_otp').update({delivered_at:new Date().toISOString()}).eq('id',id).is('invalidated_at',null));
  }
  async deliveryFailed(id) {
    data(await this.db.from('buyer_portal_otp').update({invalidated_at:new Date().toISOString()}).eq('id',id));
  }
  async confirm({id,telegramId,codeHash}) {
    return data(await this.db.rpc('buyer_portal_confirm_otp',{p_id:id,p_telegram_id:telegramId,p_code_hash:codeHash}));
  }
  async access(telegramId) {
    return data(await this.db.rpc('buyer_portal_access',{p_telegram_id:telegramId}));
  }
  async unlink(leadId,userId) {
    data(await this.db.rpc('buyer_portal_unlink',{p_lead_id:leadId,p_actor_user_id:userId}));
  }
}
