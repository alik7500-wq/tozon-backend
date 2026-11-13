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
  async contractList(telegramId){return data(await this.db.rpc('buyer_portal_contracts',{p_telegram_id:telegramId}));}
  async contractSnapshot(telegramId,dealId){return data(await this.db.rpc('buyer_portal_contract_snapshot',{p_telegram_id:telegramId,p_deal_id:dealId}));}
  async materials(telegramId,dealId){return data(await this.db.rpc('buyer_portal_materials',{p_telegram_id:telegramId,p_deal_id:dealId}));}
  async documentList(dealId,owner){return data(await this.db.from('buyer_portal_documents').select('id,title,kind,language,version,is_signed_original,status,created_at,published_at').eq('deal_id',dealId).eq('owner_lead_id',owner).order('created_at',{ascending:false}));}
  async staffDocument(dealId,id,owner){return data(await this.db.from('buyer_portal_documents').select('storage_path,mime_type,file_size,sha256').eq('deal_id',dealId).eq('id',id).eq('owner_lead_id',owner).maybeSingle());}
  async createDocument(row){return data(await this.db.rpc('buyer_portal_register_document',{p_document:row}));}
  async publishDocument(dealId,id,owner,actor,action){return data(await this.db.rpc('buyer_portal_publish_document',{p_deal_id:dealId,p_id:id,p_owner:owner,p_actor:actor,p_action:action}));}
  async unlink(leadId,userId) {
    data(await this.db.rpc('buyer_portal_unlink',{p_lead_id:leadId,p_actor_user_id:userId}));
  }
  async visit(tokenHash,telegramId) {
    return data(await this.db.rpc('buyer_portal_visit',{p_token_hash:tokenHash,p_telegram_id:String(telegramId)}));
  }
  async knownTelegram(telegramId) {
    const binding=data(await this.db.from('buyer_portal_bindings').select('id').eq('telegram_id',String(telegramId)).limit(1));
    if (binding.length) return true; // Includes revoked identities: never register them as finance subscribers.
    const visits=data(await this.db.from('buyer_portal_audit').select('id').eq('telegram_id',String(telegramId)).eq('event','BUYER_OPENED').limit(1));
    return visits.length>0;
  }
  async bindingStatus(leadId,dealId) {
    const binding=data(await this.db.from('buyer_portal_bindings').select('id,verified_at,last_active_at').eq('lead_id',leadId).is('revoked_at',null).maybeSingle());
    if (!binding) return {connected:false,contractAccess:false};
    const grant=data(await this.db.from('buyer_portal_grants').select('id').eq('binding_id',binding.id).eq('deal_id',dealId).is('revoked_at',null).maybeSingle());
    return {connected:true,contractAccess:Boolean(grant),verifiedAt:binding.verified_at,lastActiveAt:binding.last_active_at};
  }
  async language(telegramId,language) {
    data(await this.db.from('buyer_portal_bindings').update({language,last_active_at:new Date().toISOString()}).eq('telegram_id',telegramId).is('revoked_at',null));
  }
}
