import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { createBuyerInviteToken, hashBuyerInviteToken } from './telegram-auth.js';
import { hasSection, isMatrixUser } from '../../middleware/sectionAccess.js';
import {projectBuyerContract,projectBuyerArchive} from './financial-projection.js';

export class BuyerPortalError extends Error {
  constructor(code, status = 400) { super(code); this.statusCode = status; }
}
const fail = (code, status) => { throw new BuyerPortalError(code, status); };
export const buyerEnabled = () => process.env.BUYER_PORTAL_ENABLED === 'true';
export function registeredPhone(value) {
  const digits = String(value || '').replace(/[\s()+-]/g, '');
  // Existing Payom integration is Tajikistan-only. Never guess a foreign country code.
  if (/^\d{9}$/.test(digits)) return `+992${digits}`;
  if (/^992\d{9}$/.test(digits)) return `+${digits}`;
  return null;
}
export function otpDigest(secret, id, telegramId, code) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) fail('BUYER_OTP_NOT_CONFIGURED',503);
  return createHmac('sha256',secret).update(JSON.stringify(['buyer-otp-v1',id,String(telegramId),code])).digest('hex');
}
function telegramId(value) {
  if (!/^[1-9]\d{0,15}$/.test(String(value)) || !Number.isSafeInteger(Number(value))) fail('INVALID_TELEGRAM_AUTH',401);
  return String(value);
}
export class BuyerIdentityService {
  constructor({ repo, sms, botIdentity, otpSecret = () => process.env.BUYER_OTP_SECRET }) {
    this.repo=repo; this.sms=sms; this.botIdentity=botIdentity; this.otpSecret=otpSecret;
  }
  assertStaff(user, deal, {allowCancelled=false}={}) {
    const allowed = user?.is_active && (isMatrixUser(user)
      ? hasSection(user,'deals.view',true) || hasSection(user,'contracts.view',true)
      : ['ADMIN','DIRECTOR','SALES_MANAGER'].includes(user.role));
    // Any non-administrative employee is scoped to their assigned contracts.
    if (!allowed || (!['ADMIN','DIRECTOR'].includes(user.role) && String(deal?.responsible_user_id)!==String(user.id))) fail('BUYER_ACCESS_DENIED',403);
    if (!deal || (deal.status!=='SIGNED'&&!(allowCancelled&&deal.status==='CANCELLED'))) fail('BUYER_CONTRACT_UNAVAILABLE',409);
  }
  async createInvite(dealId,user,participantId) {
    if (!/^[1-9]\d{0,9}$/.test(String(dealId))||Number(dealId)>2147483647) fail('INVALID_CONTRACT');
    const deal=await this.repo.deal(dealId);
    this.assertStaff(user,deal);
    let target={id:deal.lead_id,phone:deal.leads?.phone};
    if(participantId){
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(participantId)))fail('BUYER_PARTICIPANT_INVALID');
      const participant=await this.repo.participant(participantId,deal.id);
      if(!participant||participant.owner_lead_id!==deal.lead_id)fail('BUYER_ACCESS_DENIED',403);
      target=await this.repo.lead(participant.lead_id);
    }
    if (!registeredPhone(target?.phone)) fail('BUYER_PHONE_REQUIRES_STAFF_VERIFICATION',409);
    // Configuration errors must be found before creating a usable invitation.
    otpDigest(this.otpSecret(),'configuration-check','1','000000');
    const bot=await this.botIdentity();
    if (!/^[A-Za-z0-9_]{5,32}$/.test(bot?.username||'')) fail('BUYER_BOT_NOT_CONFIGURED',503);
    const {token,tokenHash}=createBuyerInviteToken();
    const invite=await this.repo.createInvite({token_hash:tokenHash,deal_id:deal.id,lead_id:target.id,owner_lead_id:deal.lead_id,participant_id:participantId||null,
      phone_snapshot:target.phone,created_by:user.id});
    return {id:invite.id,url:`https://t.me/${bot.username}?start=buyer_${token}`,expiresAt:invite.expires_at};
  }
  async requestCode(token,verifiedTelegramId) {
    const tg=telegramId(verifiedTelegramId);
    let tokenHash;
    try { tokenHash=hashBuyerInviteToken(token); } catch { fail('BUYER_INVITE_UNAVAILABLE',410); }
    const id=randomUUID(), code=String(randomInt(0,1000000)).padStart(6,'0');
    const digest=otpDigest(this.otpSecret(),id,tg,code);
    const result=await this.repo.prepare({tokenHash,telegramId:tg,id,codeHash:digest});
    if (result.status==='RATE_LIMITED') fail('BUYER_OTP_RATE_LIMITED',429);
    if (result.status!=='PREPARED') fail('BUYER_INVITE_UNAVAILABLE',410);
    const phone=registeredPhone(result.phone);
    if (!phone) { await this.repo.deliveryFailed(id); fail('BUYER_PHONE_REQUIRES_STAFF_VERIFICATION',409); }
    let sent;
    try {
      sent=await this.sms.sendSms({phone,text:`TOZON: рамзи тасдиқ ${code}. Муҳлат: 5 дақиқа. Рамзро ба касе надиҳед. / Код подтверждения ${code}. Не сообщайте его другим.`});
    } catch { /* Provider errors may contain PII or credentials; return a fixed error. */ }
    // A provider mock can NEVER establish a real buyer identity, including development.
    if (!sent?.success || sent.isMock !== false) {
      await this.repo.deliveryFailed(id);
      fail('BUYER_SMS_UNAVAILABLE',503);
    }
    await this.repo.delivered(id);
    return {challengeId:id,maskedPhone:`+992•••••${phone.slice(-4)}`,expiresInSeconds:300};
  }
  async confirmCode(id,code,verifiedTelegramId) {
    const tg=telegramId(verifiedTelegramId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id)) || !/^\d{6}$/.test(String(code))) fail('BUYER_CODE_INVALID');
    const result=await this.repo.confirm({id,telegramId:tg,codeHash:otpDigest(this.otpSecret(),id,tg,String(code))});
    if (result.status==='STAFF_REVIEW_REQUIRED') fail('BUYER_BINDING_REQUIRES_STAFF_REVIEW',409);
    if (result.status!=='VERIFIED') fail('BUYER_CODE_INVALID');
    return {verified:true};
  }
  async contracts(verifiedTelegramId) { const tg=telegramId(verifiedTelegramId);const [active,archived]=await Promise.all([this.repo.access(tg),this.repo.archiveAccess(tg)]);return [...active,...archived.map(a=>({...a,archived:true}))]; }
  async contractList(verifiedTelegramId){const tg=telegramId(verifiedTelegramId),list=await this.repo.contractList(tg);if(list.length)await this.repo.touch(tg);return list;}
  async contract(verifiedTelegramId,dealId){
    if(!/^[1-9]\d{0,9}$/.test(String(dealId))||Number(dealId)>2147483647)fail('BUYER_CONTRACT_UNAVAILABLE',404);
    const snapshot=await this.repo.contractSnapshot(telegramId(verifiedTelegramId),dealId);
    if(!snapshot){
      const archived=await this.repo.archiveSnapshot(telegramId(verifiedTelegramId),dealId);
      if(!archived)fail('BUYER_CONTRACT_UNAVAILABLE',404);
      try{return projectBuyerArchive(archived);}catch{fail('BUYER_FINANCE_REVIEW_REQUIRED',409);}
    }
    try{return projectBuyerContract(snapshot);}catch{fail('BUYER_FINANCE_REVIEW_REQUIRED',409);}
  }
  async staffStatus(dealId,user,participantId) {
    const deal=await this.repo.deal(dealId); this.assertStaff(user,deal,{allowCancelled:true});
    let leadId=deal.lead_id;
    if(participantId){
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(participantId)))fail('BUYER_PARTICIPANT_INVALID');
      const participant=await this.repo.participant(participantId,deal.id);
      if(!participant||participant.owner_lead_id!==deal.lead_id)fail('BUYER_ACCESS_DENIED',403);
      leadId=participant.lead_id;
    }
    return this.repo.bindingStatus(leadId,deal.id);
  }
  async preferences(verifiedTelegramId,language) {
    const tg=telegramId(verifiedTelegramId);
    if (!['tj','ru'].includes(language)) fail('BUYER_LANGUAGE_INVALID');
    if (!(await this.contracts(tg)).length) fail('BUYER_ACCESS_DENIED',403);
    await this.repo.language(tg,language); return {language};
  }
  async participantList(dealId,user){const deal=await this.repo.deal(dealId);this.assertStaff(user,deal,{allowCancelled:true});return this.repo.participants(deal.id,deal.lead_id);}
  async participantCandidate(dealId,user,leadId){
    const deal=await this.repo.deal(dealId);this.assertStaff(user,deal);
    if(!['ADMIN','DIRECTOR'].includes(user.role))fail('BUYER_ACCESS_DENIED',403);
    if(!/^[1-9]\d{0,9}$/.test(String(leadId))||Number(leadId)>2147483647)fail('BUYER_PARTICIPANT_INVALID');
    const lead=await this.repo.lead(leadId),phone=registeredPhone(lead?.phone);
    if(!lead||!phone||String(lead.id)===String(deal.lead_id))fail('BUYER_PARTICIPANT_INVALID');
    return {id:lead.id,name:lead.full_name,maskedPhone:`+992•••••${phone.slice(-4)}`};
  }
  async addParticipant(dealId,user,{leadId,role,basis,verified}){
    const deal=await this.repo.deal(dealId);this.assertStaff(user,deal);
    if(!['ADMIN','DIRECTOR'].includes(user.role))fail('BUYER_ACCESS_DENIED',403);
    if(verified!==true||!['CO_BUYER','REPRESENTATIVE'].includes(role)||typeof basis!=='string'||basis.trim().length<5||basis.trim().length>500||!/^[1-9]\d{0,9}$/.test(String(leadId))||Number(leadId)>2147483647)fail('BUYER_PARTICIPANT_INVALID');
    const lead=await this.repo.lead(leadId);if(!lead||String(lead.id)===String(deal.lead_id))fail('BUYER_PARTICIPANT_INVALID');
    if(!registeredPhone(lead.phone))fail('BUYER_PHONE_REQUIRES_STAFF_VERIFICATION',409);
    return {id:await this.repo.addParticipant(deal.id,lead.id,role,basis.trim(),user.id)};
  }
  async revokeParticipant(dealId,user,id){
    const deal=await this.repo.deal(dealId);this.assertStaff(user,deal,{allowCancelled:true});
    if(!['ADMIN','DIRECTOR'].includes(user.role))fail('BUYER_ACCESS_DENIED',403);
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id)))fail('BUYER_PARTICIPANT_INVALID');
    await this.repo.revokeParticipant(deal.id,id,user.id);return {revoked:true};
  }
  async unlink(dealId,user) {
    const deal=await this.repo.deal(dealId);
    this.assertStaff(user,deal,{allowCancelled:true});
    // Revoking a buyer identity affects all their contracts; only leadership may do it.
    if (!['ADMIN','DIRECTOR'].includes(user.role)) fail('BUYER_ACCESS_DENIED',403);
    await this.repo.unlink(deal.lead_id,user.id);
    return {unlinked:true};
  }
}
