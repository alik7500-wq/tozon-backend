import {getServiceDB} from '../../db/connection.js';
const checked=r=>{if(r.error)throw new Error('BUYER_COMMUNICATION_UNAVAILABLE');return r.data;};
export class BuyerCommunicationsRepository{
 constructor(db){this.database=db;}
 get db(){return this.database||getServiceDB();}
 async settings(tg){const b=checked(await this.db.from('buyer_portal_bindings').select('language,notifications_enabled').eq('telegram_id',tg).is('revoked_at',null).maybeSingle());return b?{language:b.language,enabled:b.notifications_enabled}:null;}
 async saveSettings(tg,enabled,language){return checked(await this.db.rpc('buyer_portal_notification_settings',{p_telegram:tg,p_enabled:enabled,p_language:language}));}
 async contact(tg,deal,id,message){return checked(await this.db.rpc('buyer_portal_contact',{p_telegram:tg,p_deal:deal,p_id:id,p_message:message}));}
 async inquiries(tg,deal){return checked(await this.db.rpc('buyer_portal_inquiry_history',{p_telegram:tg,p_deal:deal}));}
 async staffInquiries(deal,lead){return checked(await this.db.from('buyer_portal_inquiries').select('id,message,status,reply,created_at,replied_at').eq('deal_id',deal).eq('lead_id',lead).order('created_at',{ascending:false}).limit(100));}
 async reply(deal,id,actor,message){return checked(await this.db.rpc('buyer_portal_reply',{p_deal:deal,p_id:id,p_actor:actor,p_reply:message}));}
 async notices(tg){return checked(await this.db.rpc('buyer_portal_notice_history',{p_telegram:tg}));}
 async read(tg,id){checked(await this.db.rpc('buyer_portal_read_notice',{p_telegram:tg,p_id:id}));}
 async candidates(){return checked(await this.db.rpc('buyer_portal_reminder_candidates'));}
 async enqueue(deal,kind,key,due){checked(await this.db.rpc('buyer_portal_queue_notice',{p_deal:deal,p_kind:kind,p_key:key,p_source:null,p_version:null,p_due:due}));}
 async claim(worker){return checked(await this.db.rpc('buyer_portal_claim_notice',{p_worker:worker}));}
 async context(id,worker){return checked(await this.db.rpc('buyer_portal_notice_context',{p_id:id,p_worker:worker}));}
 async finish(id,worker,status,error=null,delay=60){checked(await this.db.rpc('buyer_portal_finish_notice',{p_id:id,p_worker:worker,p_status:status,p_error:error,p_delay:delay}));}
}
