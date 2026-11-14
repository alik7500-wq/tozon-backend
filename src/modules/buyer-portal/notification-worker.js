import {randomUUID} from 'node:crypto';
import {buyerEnabled} from './identity.service.js';
import {buyerAppUrl} from './bot.js';
const day=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Dushanbe',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
const days=(date,today)=>Math.round((Date.parse(date+'T00:00:00Z')-Date.parse(today+'T00:00:00Z'))/86400000);
const effective=(s,first)=>first&&s.dueDate<first?first:s.dueDate;
export const notificationsEnabled=()=>{
 if(!buyerEnabled()||process.env.BUYER_NOTIFICATIONS_ENABLED!=='true'||!process.env.TELEGRAM_FINANCE_BOT_TOKEN?.trim())return false;
 try{buyerAppUrl();return true;}catch{return false;}
};
export function noticeText(n){
 const ru={PAYMENT:'Учтена оплата.',PAYMENT_VOIDED:'Платёж аннулирован. Проверьте историю оплат.',DOCUMENT:'В кабинете доступен новый документ.',SCHEDULE_CHANGED:'Обновлён график оплаты.',TERMS_CHANGED:'Обновлены сведения договора.',REMINDER_7:'До платежа по графику 7 дней.',REMINDER_3:'До платежа по графику 3 дня.',REMINDER_0:'Сегодня срок платежа по графику.',OVERDUE:'Есть просроченная оплата. Проверьте график.',INQUIRY_REPLY:'Менеджер ответил на Ваше обращение.'};
 const tj={PAYMENT:'Пардохт ба ҳисоб гирифта шуд.',PAYMENT_VOIDED:'Пардохт бекор шуд. Таърихи пардохтҳоро санҷед.',DOCUMENT:'Ҳуҷҷати нав дар кабинет дастрас аст.',SCHEDULE_CHANGED:'Ҷадвали пардохт нав шуд.',TERMS_CHANGED:'Маълумоти шартнома нав шуд.',REMINDER_7:'То пардохти навбатӣ 7 рӯз мондааст.',REMINDER_3:'То пардохти навбатӣ 3 рӯз мондааст.',REMINDER_0:'Имрӯз муҳлати пардохти навбатӣ аст.',OVERDUE:'Пардохти муҳлатгузашта мавҷуд аст. Ҷадвалро санҷед.',INQUIRY_REPLY:'Менеҷер ба муроҷиати шумо ҷавоб дод.'};
 const isRu=n.language==='ru';
 if(n.kind==='PAYMENT'&&n.payment){
  const p=n.payment,money=(amount,currency)=>`${new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(amount/100)} ${currency}`;
  return isRu?`Ваш платёж принят.\nДоговор: №${n.contractNumber}\nСумма: ${money(p.amountMinor,p.currency)}\nДата: ${p.date}\nВсего оплачено: ${money(p.paidMinor,p.contractCurrency)}\nОстаток задолженности: ${money(p.remainingMinor,p.contractCurrency)}\nБлагодарим за оплату!`
   :`Пардохти Шумо қабул гардид.\nШартнома: №${n.contractNumber}\nМаблағ: ${money(p.amountMinor,p.currency)}\nСана: ${p.date}\nҲамагӣ пардохтшуда: ${money(p.paidMinor,p.contractCurrency)}\nБақияи қарз: ${money(p.remainingMinor,p.contractCurrency)}\nТашаккур барои пардохт!`;
 }
 return `${isRu?'Договор':'Шартнома'} №${n.contractNumber}\n${(isRu?ru:tj)[n.kind]||''}\n${isRu?'Подробности в личном кабинете.':'Тафсилот дар кабинети шахсӣ.'}`;
}
export class BuyerNotificationWorker{
 constructor({repo,identity,api,clock=()=>new Date(),enabled=notificationsEnabled,url=buyerAppUrl,logger=console}){
  Object.assign(this,{repo,identity,api,clock,enabled,url,logger});this.id=randomUUID();this.active=null;this.stopping=false;
 }
 async collect(){
  const now=this.clock(),hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dushanbe',hour:'2-digit',hourCycle:'h23'}).format(now));
  if(hour<9||hour>=20)return;
  const today=day(now);
  for(const candidate of await this.repo.candidates()){
   if(!this.enabled()||this.stopping)return;
   try{
    const d=await this.identity.contract(candidate.telegramId,candidate.dealId);
    if(d.warnings.includes('SCHEDULE_REVIEW_REQUIRED'))continue;
    const dueDates=new Set(d.schedules.filter(s=>s.remainingMinor>0).map(s=>effective(s,d.summary.firstPaymentDate)));
    for(const due of dueDates){
     const delta=days(due,today);if(![7,3,0].includes(delta))continue;
     const kind=`REMINDER_${delta}`;await this.repo.enqueue(d.id,kind,`${kind}:${d.id}:${due}`,due);
    }
    const oldest=d.schedules.filter(s=>s.status==='OVERDUE'&&s.remainingMinor>0).map(s=>effective(s,d.summary.firstPaymentDate)).sort()[0];
    if(oldest&&d.summary.overdueMinor>0)await this.repo.enqueue(d.id,'OVERDUE',`OVERDUE:${d.id}:${oldest}`,oldest);
   }catch{/* Unreconciled/withdrawn contracts must not produce financial reminders. */}
  }
 }
 async stillDue(n){
  if(!n.kind.startsWith('REMINDER_')&&n.kind!=='OVERDUE')return true;
  const d=await this.identity.contract(n.telegramId,n.dealId),today=day(this.clock());
  if(d.warnings.includes('SCHEDULE_REVIEW_REQUIRED'))return false;
  if(n.kind==='OVERDUE')return d.summary.overdueMinor>0&&d.schedules.some(s=>s.status==='OVERDUE'&&s.remainingMinor>0&&effective(s,d.summary.firstPaymentDate)===n.dueDate);
  const expected=Number(n.kind.split('_')[1]);
  return days(n.dueDate,today)===expected&&d.schedules.some(s=>s.remainingMinor>0&&effective(s,d.summary.firstPaymentDate)===n.dueDate);
 }
 async run(){
  if(!this.enabled()||this.stopping)return;
  await this.collect();
  for(let i=0;i<5&&this.enabled()&&!this.stopping;i++){
   const item=await this.repo.claim(this.id);if(!item)return;
   let context;
   try{context=await this.repo.context(item.id,this.id);if(!context||!await this.stillDue(context)){await this.repo.finish(item.id,this.id,'CANCELLED');continue;}}
   catch{await this.repo.finish(item.id,this.id,'CANCELLED');continue;}
   if(context.kind==='PAYMENT'){
    try{
     const d=await this.identity.contract(context.telegramId,context.dealId);
     const p=d.history.find(p=>p.kind==='PAYMENT'&&String(p.id)===String(context.sourceId)&&['ACTIVE','POSTED'].includes(p.status));
     if(!p||d.archived||!await this.repo.context(item.id,this.id))throw new Error('PAYMENT_UNAVAILABLE');
     context={...context,payment:{amountMinor:p.amountMinor,currency:p.currency,date:p.date,paidMinor:d.summary.paidMinor,remainingMinor:d.summary.remainingMinor,contractCurrency:d.summary.currency}};
    }catch{await this.repo.finish(item.id,this.id,'CANCELLED');continue;}
   }
   let url;
   try{url=this.url();}catch{await this.repo.finish(item.id,this.id,'FAILED','URL_NOT_CONFIGURED');continue;}
   if(!this.enabled()||this.stopping){await this.repo.finish(item.id,this.id,'CANCELLED');return;}
   try{
    await this.api.send(context.telegramId,noticeText(context),{inline_keyboard:[[{text:context.language==='ru'?'Открыть кабинет':'Кабинетро кушодан',web_app:{url}}]]},{mainMenu:false});
   }catch(error){
    if(Number(error.code)===429){await this.repo.finish(item.id,this.id,'PENDING','TELEGRAM_429',Math.max(1,Math.min(3600,Number(error.retryAfter)||60)));}
    else if([400,403].includes(Number(error.code))){await this.repo.finish(item.id,this.id,'FAILED',`TELEGRAM_${Number(error.code)}`);}
    else await this.repo.finish(item.id,this.id,'UNKNOWN','DELIVERY_UNCERTAIN');
    continue;
   }
   // Never retry a possibly accepted message after an acknowledgement write fails.
   await this.repo.finish(item.id,this.id,'SENT');
  }
 }
 tick(){
  if(this.active||this.stopping||!this.enabled())return this.active||Promise.resolve();
  this.active=this.run().catch(()=>this.logger.warn('Buyer notifications unavailable')).finally(()=>{this.active=null;});return this.active;
 }
 start(){if(this.timer||!this.enabled())return;this.stopping=false;void this.tick();this.timer=setInterval(()=>void this.tick(),10000);this.timer.unref();}
 async stop(){this.stopping=true;clearInterval(this.timer);this.timer=null;await this.active;}
}
