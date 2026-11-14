import {BuyerPortalError} from './identity.service.js';
const uuid=v=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v));
export class BuyerCommunicationsService{
 constructor({repo,identity}){this.repo=repo;this.identity=identity;}
 async allowed(tg,dealId){
  if(!/^[1-9]\d{0,9}$/.test(String(dealId))||Number(dealId)>2147483647)throw new BuyerPortalError('BUYER_ACCESS_DENIED',403);
  const grants=await this.identity.contracts(tg);
  if(!grants.some(g=>String(g.deal_id)===String(dealId)))throw new BuyerPortalError('BUYER_ACCESS_DENIED',403);
 }
 async settings(tg){
  if(!(await this.identity.contracts(tg)).length)throw new BuyerPortalError('BUYER_ACCESS_DENIED',403);
  return this.repo.settings(tg);
 }
 async saveSettings(tg,{enabled,language}){
  if(typeof enabled!=='boolean'||language!==undefined&&!['tj','ru'].includes(language))throw new BuyerPortalError('BUYER_SETTINGS_INVALID');
  const result=await this.repo.saveSettings(tg,enabled,language||null);
  if(!result)throw new BuyerPortalError('BUYER_ACCESS_DENIED',403);return result;
 }
 async contact(tg,{dealId,id,message}){
  if(!uuid(id)||typeof message!=='string'||!message.trim()||message.trim().length>2000)throw new BuyerPortalError('BUYER_INQUIRY_INVALID');
  await this.allowed(tg,dealId);
  const result=await this.repo.contact(tg,dealId,id,message.trim());
  if(result.status==='RATE_LIMITED')throw new BuyerPortalError('BUYER_INQUIRY_RATE_LIMITED',429);
  if(result.status!=='ACCEPTED')throw new BuyerPortalError('BUYER_ACCESS_DENIED',403);return {id:result.id};
 }
 async history(tg,dealId){await this.allowed(tg,dealId);return this.repo.inquiries(tg,dealId);}
 async notices(tg){return this.repo.notices(tg);}
 async read(tg,id){if(!uuid(id))throw new BuyerPortalError('BUYER_NOTICE_INVALID');await this.repo.read(tg,id);return {read:true};}
 async staffList(dealId,user){const deal=await this.identity.repo.deal(dealId);this.identity.assertStaff(user,deal);return this.repo.staffInquiries(deal.id,deal.lead_id);}
 async staffNotices(dealId,user){const deal=await this.identity.repo.deal(dealId);this.identity.assertStaff(user,deal,{allowCancelled:true});return this.repo.staffNotices(deal.id,deal.lead_id);}
 async reply(dealId,user,{id,message}){
  if(!uuid(id)||typeof message!=='string'||!message.trim()||message.trim().length>2000)throw new BuyerPortalError('BUYER_INQUIRY_INVALID');
  const deal=await this.identity.repo.deal(dealId);this.identity.assertStaff(user,deal);
  return {status:await this.repo.reply(deal.id,id,user.id,message.trim())};
 }
}
