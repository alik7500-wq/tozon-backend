import { DocumentsRepository } from '../documents/documents.repository.js';
import crypto from 'node:crypto';
import { getServiceDB } from '../../db/connection.js';
import { UsersRepository } from '../users/users.repository.js';
import { hasSection, isMatrixUser } from '../../middleware/sectionAccess.js';
import { AIDocumentRecognitionService } from '../documents/aiDocumentRecognitionService.js';

export const canScan = u => Boolean(u?.is_active) && (isMatrixUser(u)
  ? hasSection(u, 'leads.view', true) || hasSection(u, 'deals.view', true)
  : ['ADMIN','DIRECTOR','SALES_MANAGER'].includes(u.role));
const check = r => { if(r.error) throw r.error; return r.data; };
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
export class PassportBridge {
  constructor({db, users=UsersRepository, analyze=AIDocumentRecognitionService.analyzePassportImages.bind(AIDocumentRecognitionService)}={}) { this.database=db; this.users=users; this.analyze=analyze; }
  get db() { return this.database || getServiceDB(); }
  async cleanup() { check(await this.db.from('telegram_passport_sessions').delete().lt('expires_at',new Date().toISOString())); }
  async binding(userId, {allowFinance=true}={}) {
    const existing=check(await this.db.from('telegram_passport_bindings').select('*').eq('user_id',userId).maybeSingle());
    if(existing) return existing;
    if(!allowFinance) return null;
    // Only an administrator-approved, unambiguous CRM link is trusted for first use.
    const finance=check(await this.db.from('telegram_finance_subscribers').select('telegram_id,display_name').eq('crm_user_id',userId).eq('status','APPROVED').limit(2));
    if(finance.length!==1) return null;
    return check(await this.db.from('telegram_passport_bindings').insert({user_id:userId,telegram_id:finance[0].telegram_id,telegram_name:finance[0].display_name||''}).select().single());
  }
  async create(user) {
    if(!canScan(user)) throw new Error('PASSPORT_ACCESS_DENIED');
    await this.cleanup();
    const linked=await this.binding(user.id);
    const token=crypto.randomBytes(24).toString('hex');
    const session=check(await this.db.from('telegram_passport_sessions').insert({user_id:user.id,token_hash:hash(token),...(linked?{telegram_id:linked.telegram_id,telegram_name:linked.telegram_name,status:'UPLOAD'}:{}),expires_at:new Date(Date.now()+15*60000).toISOString()}).select('id,expires_at,status,telegram_name').single());
    return {...session,linked:Boolean(linked),url:`https://t.me/TozonFinanceBot?start=passport_${token}`};
  }
  async owned(id,user) {
    if(!canScan(user)) throw new Error('PASSPORT_ACCESS_DENIED');
    const s=check(await this.db.from('telegram_passport_sessions').select('*').eq('id',id).eq('user_id',user.id).gt('expires_at',new Date().toISOString()).maybeSingle());
    if(!s) throw new Error('PASSPORT_SESSION_EXPIRED');
    return s;
  }
  async patch(s,fields,status=s.status) { return check(await this.db.from('telegram_passport_sessions').update(fields).eq('id',s.id).eq('status',status).select().maybeSingle()); }
  async status(id,user) { const s=await this.owned(id,user); return {id:s.id,status:s.status,telegram_name:s.telegram_name,result:s.status==='READY'?s.result:null,image_count:s.status==='READY'?s.file_ids.length:0}; }
  async approve(id,user) {
    const s=await this.owned(id,user);
    if(s.status!=='PAIRING'||!s.telegram_id)return false;
    check(await this.db.from('telegram_passport_bindings').upsert({user_id:user.id,telegram_id:s.telegram_id,telegram_name:s.telegram_name||'',verified_at:new Date().toISOString()},{onConflict:'user_id'}));
    return Boolean(await this.patch(s,{status:'UPLOAD'},'PAIRING'));
  }
  async sendLink(id,user,url,api) {
    const s=await this.owned(id,user),linked=await this.binding(user.id,{allowFinance:false});
    const token=/^https:\/\/t\.me\/TozonFinanceBot\?start=passport_([a-f0-9]{48})$/.exec(String(url||''))?.[1];
    if(!token||hash(token)!==s.token_hash||s.status!=='UPLOAD'||!linked||linked.telegram_id!==s.telegram_id)throw new Error('PASSPORT_LINK_DENIED');
    await api.call('sendMessage',{chat_id:linked.telegram_id,text:'📷 Сканирование паспорта для открытого договора в CRM. Отправьте фото паспорта в этот чат, затем нажмите «Распознать паспорт».',reply_markup:{inline_keyboard:[[{text:'Открыть сканирование',url}]]}});
    return true;
  }
  async consume(id,user) { const s=await this.owned(id,user); return Boolean(await this.patch(s,{status:'CONSUMED',result:null,file_ids:[]},'READY')); }
  async cancel(id,user) { const s=await this.owned(id,user); check(await this.db.from('telegram_passport_sessions').delete().eq('id',s.id).eq('user_id',user.id)); }
  async downloadPhoto(fileId,api) {
    const file=await api.call('getFile',{file_id:fileId});
    if(!file.file_path||file.file_size>10*1024*1024||!/^photos\/[a-zA-Z0-9_.\/-]+$/.test(file.file_path)) throw new Error('PHOTO_INVALID');
    const response=await api.fetch(`https://api.telegram.org/file/bot${api.token}/${file.file_path}`,{signal:AbortSignal.timeout(15000)});
    if(!response.ok) throw new Error('PHOTO_DOWNLOAD_FAILED');
    const chunks=[];let size=0;
    for await(const chunk of response.body) { size+=chunk.length;if(size>10*1024*1024)throw new Error('PHOTO_TOO_LARGE');chunks.push(chunk); }
    return {buffer:Buffer.concat(chunks),mimeType:'image/jpeg'};
  }
  async image(id,user,index,api) {
    const s=await this.owned(id,user);
    if(s.status!=='READY'||!Number.isInteger(index)||index<0||index>=s.file_ids.length) throw new Error('PHOTO_UNAVAILABLE');
    return this.downloadPhoto(s.file_ids[index],api);
  }
  async handle(update,api) {
    const cb=update.callback_query, m=cb?.message||update.message, sender=cb?.from||m?.from;
    if(!sender||sender.is_bot||m?.chat?.type!=='private'||String(m.chat.id)!==String(sender.id)) return false;
    const token=/^\/start(?:@\w+)? passport_([a-f0-9]{48})$/.exec(m.text||'')?.[1];
    const command=cb?.data||'';
    const explicit=Boolean(token)||command.startsWith('passport:');
    const send=(text,buttons)=>api.call('sendMessage',{chat_id:sender.id,text,...(buttons?{reply_markup:{inline_keyboard:buttons}}:{})});
    let s;
    if(token) {
      s=check(await this.db.from('telegram_passport_sessions').select('*').eq('token_hash',hash(token)).gt('expires_at',new Date().toISOString()).maybeSingle());
      if(!s){await send('Ссылка истекла. Создайте новую в CRM.');return true;}
      if(!canScan(await this.users.findById(s.user_id))){await send('Доступ к сканированию закрыт.');return true;}
      if(s.telegram_id&&s.telegram_id!==String(sender.id)){await send('Эта ссылка предназначена другому менеджеру.');return true;}
      if(s.status==='UPLOAD'&&s.telegram_id===String(sender.id)){
        await send('📷 Отправьте фото паспорта в этот чат. Если документ двусторонний — отправьте обе стороны.');return true;
      }
      if(s.status==='PENDING'){
        s=await this.patch(s,{status:'PAIRING',telegram_id:String(sender.id),telegram_name:[sender.first_name,sender.last_name].filter(Boolean).join(' ').slice(0,100)});
        await send(s?'Подтвердите первое подключение Telegram в CRM. В следующий раз повторять это не потребуется.':'Ссылка уже используется.');return true;
      }
      await send(s.status==='PAIRING'?'Подтвердите первое подключение в CRM.':'Эта сессия уже используется. Вернитесь к текущему шагу сканирования.');return true;
    }
    if(!explicit&&!m.photo) return false;
    let q=this.db.from('telegram_passport_sessions').select('*').eq('telegram_id',String(sender.id)).gt('expires_at',new Date().toISOString());
    if(explicit) q=q.eq('id',command.split(':')[2]);
    else q=q.in('status',['PAIRING','UPLOAD','REVIEW']).order('created_at',{ascending:false}).limit(1);
    s=check(await q.maybeSingle());
    if(!s) { if(explicit) await send('Сессия недоступна. Откройте сканирование из CRM.'); return explicit; }
    const user=await this.users.findById(s.user_id);
    if(!canScan(user)) { await this.patch(s,{status:'CANCELLED',result:null,file_ids:[]}); await send('Доступ к распознаванию отозван.'); return true; }
    if(m.photo&&!cb) {
      if(s.status!=='UPLOAD') { await send('Сначала подтвердите подключение в CRM.'); return true; }
      if(s.file_ids.length>=4) { await send('Максимум 4 фотографии.'); return true; }
      const photo=m.photo.at(-1);
      if(photo.file_size>10*1024*1024) { await send('Фото должно быть не больше 10 МБ.'); return true; }
      await this.patch(s,{file_ids:[...s.file_ids,photo.file_id]});
      // Remove the queued file handle once processed; no image bytes are stored by CRM.
      if(s.file_ids.length===0) {
        await send('✅ Первая страница получена.\n\n📷 Теперь сфотографируйте и отправьте вторую страницу паспорта или оборотную сторону ID-карты — с адресом регистрации и дополнительными данными.\n\nРаспознавание будет доступно после второго фото.');
      } else {
        await send(`✅ Получено фотографий: ${s.file_ids.length+1}.\n\nМожно распознать обе страницы вместе. При необходимости сначала отправьте дополнительные страницы.`,[[{text:'Распознать паспорт',callback_data:`passport:scan:${s.id}`}]]);
      }
      return true;
    }
    if(command===`passport:scan:${s.id}`&&s.status==='UPLOAD'&&s.file_ids.length<2) {
      await send('📷 Перед распознаванием отправьте вторую страницу паспорта или оборотную сторону ID-карты.');return true;
    }
    if(command===`passport:scan:${s.id}`&&s.status==='UPLOAD'&&s.file_ids.length>=2) {
      if(!await this.patch(s,{status:'PROCESSING'})) return true;
      await send('Распознаю паспорт. Результат потребуется проверить.');
      try {
        const images=[];
        for(const fileId of s.file_ids) {
          images.push(await this.downloadPhoto(fileId,api));
        }
        const result=await this.analyze(images);
        await DocumentsRepository.logScanEvent({userId:s.user_id,clientId:null,eventType:'PASSPORT_AI_SCANNED',documentCountry:result.document?.country||null,documentType:result.document?.document_type||null,success:result.success,model:result.model,processingDurationMs:result.duration_ms,warningsCount:result.warnings?.length||0,conflictsCount:result.conflicts?.length||0});
        if(!result.success||!result.quality?.acceptable) throw new Error('QUALITY_REJECTED');
        const freshUser=await this.users.findById(s.user_id);
        if(!canScan(freshUser)||Date.parse(s.expires_at)<=Date.now()) throw new Error('ACCESS_REVOKED');
        const saved=await this.patch({...s,status:'PROCESSING'},{status:'REVIEW',result});
        if(saved) await send('Распознавание завершено. Передайте результат в CRM и проверьте все поля перед заполнением договора.',[[{text:'Передать в договор',callback_data:`passport:transfer:${s.id}`}]]);
      } catch { await this.patch({...s,status:'PROCESSING'},{status:'UPLOAD',result:null,file_ids:[]}); await send('Не удалось распознать. Отправьте чёткие фото заново.'); }
      return true;
    }
    if(command===`passport:transfer:${s.id}`&&s.status==='REVIEW') { await this.patch(s,{status:'READY'}); await send('Данные переданы в открытое окно CRM для проверки.');return true; }
    if(explicit) await send('Это действие уже выполнено или недоступно.');
    return explicit;
  }
}
export const passportBridge = new PassportBridge();
