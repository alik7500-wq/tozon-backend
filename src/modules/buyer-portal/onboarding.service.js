import {BuyerPortalError,registeredPhone,buyerEnabled} from './identity.service.js';
import {createBuyerInviteToken} from './telegram-auth.js';
const fail=(code,status=400)=>{throw new BuyerPortalError(code,status);};
export function invitationText(language,url){
 if(language==='tj')return `TOZON: Кабинети шахсии шумо дар Telegram: таърихи пардохтҳо, бақия, ҷадвал ва нақшаи хона. Пайвандро кушоед ва «Запустить»-ро пахш кунед: ${url}\nМенеҷер пайвастшавиро як бор тасдиқ мекунад. Муҳлати пайванд: 7 рӯз.`;
 if(language==='ru')return `TOZON: Ваш личный кабинет в Telegram: история оплат, остаток, график и план квартиры. Откройте ссылку и нажмите «Запустить»: ${url}\nМенеджер один раз подтвердит подключение. Ссылка действует 7 дней.`;
 fail('BUYER_LANGUAGE_REQUIRED');
}
export class BuyerOnboardingService{
 constructor({repo,sms,botIdentity,enabled=buyerEnabled}){Object.assign(this,{repo,sms,botIdentity,enabled});}
 assertUser(user){if(!this.enabled())fail('BUYER_PORTAL_DISABLED',404);if(!user?.is_active||!['ADMIN','DIRECTOR','SALES_MANAGER'].includes(user.role))fail('BUYER_ACCESS_DENIED',403);}
 async list(user){this.assertUser(user);return (await this.repo.onboardingList(user.id)).map(row=>({...row,validPhone:Boolean(registeredPhone(row.phone))}));}
 async preview(user,body){
  const rows=await this.list(user);if(!['tj','ru'].includes(body.language))fail('BUYER_LANGUAGE_REQUIRED');
  if(!Array.isArray(body.leadIds)||!body.leadIds.length||body.leadIds.length>10||new Set(body.leadIds.map(String)).size!==body.leadIds.length)fail('BUYER_BATCH_INVALID');
  const bot=await this.botIdentity();if(!/^[A-Za-z0-9_]{5,32}$/.test(bot?.username||''))fail('BUYER_BOT_NOT_CONFIGURED',503);
  return body.leadIds.map(id=>{
   const row=rows.find(r=>String(r.leadId)===String(id));if(!row||!row.validPhone||!row.canSend||['CONNECTED','PENDING'].includes(row.status))fail('BUYER_RECIPIENT_UNAVAILABLE',409);
   const text=invitationText(body.language,`https://t.me/${bot.username}?start=buyer_${'X'.repeat(43)}`);
   return {leadId:row.leadId,name:row.name,phone:row.phone,language:body.language,text,segments:Math.ceil(text.length/67)};
  });
 }
 async send(user,body){
  this.assertUser(user);
  if(!/^[1-9]\d{0,9}$/.test(String(body.leadId))||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId||'')||!['tj','ru'].includes(body.language)||!registeredPhone(body.expectedPhone))fail('BUYER_BATCH_INVALID');
  const bot=await this.botIdentity();if(!/^[A-Za-z0-9_]{5,32}$/.test(bot?.username||''))fail('BUYER_BOT_NOT_CONFIGURED',503);
  const {token,tokenHash}=createBuyerInviteToken();
  const prepared=await this.repo.prepareSmsInvite({leadId:Number(body.leadId),actor:user.id,hash:tokenHash,request:body.requestId,language:body.language,phone:body.expectedPhone});
  if(prepared.status!=='CREATED')return {status:prepared.status,deliveryStatus:prepared.deliveryStatus};
  let status='UNKNOWN';
  try{
   const r=await this.sms.sendSms({clientId:body.leadId,phone:registeredPhone(body.expectedPhone),text:invitationText(body.language,`https://t.me/${bot.username}?start=buyer_${token}`),dealId:prepared.dealId,userId:user.id,language:body.language,senderName:'TOZON-PLAZA'});
   status=r.success&&r.data?.isMock===false?'SENT':r.success?'FAILED':'UNKNOWN';
  }catch{/* An absent ACK must not trigger a second SMS. */}
  await this.repo.finishSmsInvite(prepared.id,status);
  return {status,expiresAt:prepared.expiresAt};
 }
}
